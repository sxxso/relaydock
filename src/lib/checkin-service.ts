import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { QueryRouteMode } from "./query-routing";
import { queryBalance } from "./query-balance";
import { checkinContext, checkinErrorState, checkinIdentity, checkinSite, createCheckinReader, knownSubmissionFailure } from "./query-checkin";
import { CheckinBusinessFailure, checkinMessages as M, checkinOperationSchema, checkinStatusSchema, type CheckinStatus, type CheckinOutcome, type CheckinResult } from "./checkin";

type Locks = { accounts: Set<string>; identities: Set<string>; sites: Set<string> };
const locks = new Map<string, Locks>();
function scope(store: Store) {
  let value = locks.get(store.modelInsightScope);
  if (!value) { value = { accounts: new Set(), identities: new Set(), sites: new Set() }; locks.set(store.modelInsightScope, value); }
  return value;
}
export function isCheckinBusy(store: Store, id: string) { return locks.get(store.modelInsightScope)?.accounts.has(id) ?? false; }
function empty(accountId: string, outcome: CheckinOutcome): CheckinResult { return { accountId, outcome, message: M[outcome], status: null, operation: null }; }
function capture(store: Store, id: string) {
  const connection = store.modelInsightConnection(id);
  const skip: CheckinOutcome | null = !connection ? "missing" : connection.account.archived ? "archived" : connection.account.provider !== "newapi" ? "unsupported" : !connection.credential ? "missing_credential" : !connection.account.userId ? "missing_identity" : null;
  return { connection, skip };
}
function unchanged(store: Store, id: string, version: string) {
  const current = store.modelInsightConnection(id);
  return !!current && current.connectionVersion === version && !current.account.archived && current.account.provider === "newapi";
}
function acquire(store: Store, id: string, identity: string, site: string) {
  const l = scope(store);
  if (l.accounts.has(id) || l.identities.has(identity) || l.sites.has(site)) return null;
  l.accounts.add(id); l.identities.add(identity); l.sites.add(site);
  return () => { l.accounts.delete(id); l.identities.delete(identity); l.sites.delete(site); if (!l.accounts.size) locks.delete(store.modelInsightScope); };
}
export function localCheckin(store: Store, id: string, month?: string) {
  const connection = store.modelInsightConnection(id);
  let uncertain = false;
  if (connection?.account.provider === "newapi") {
    try { uncertain = store.hasCheckinBarrier(checkinIdentity(connection.account)); } catch { /* no valid management root */ }
  }
  const status = store.checkinStatus(id, month);
  return { status: uncertain && status ? { ...status, state: "uncertain" as const, message: M.uncertain } : status, operations: store.checkinOperations(id), uncertain };
}
export async function readCheckinStatus(store: Store, id: string, route: QueryRouteMode, month?: string, balanceBusy: (id: string) => boolean = () => false): Promise<CheckinStatus | CheckinResult> {
  const { connection, skip } = capture(store, id);
  if (skip || !connection) return empty(id, skip || "missing");
  const identity = checkinIdentity(connection.account), site = checkinSite(connection.account);
  const release = balanceBusy(id) ? null : acquire(store, id, identity, site);
  if (!release) return empty(id, "busy");
  try {
    let status = await createCheckinReader(connection.account, connection.credential!, id, route).status(month);
    if (!unchanged(store, id, connection.connectionVersion)) return empty(id, "changed");
    if (store.hasCheckinBarrier(identity)) {
      if (status.checkedInToday === true) store.clearCheckinBarrier(identity);
      else status = { ...status, state: "uncertain", message: M.uncertain };
    }
    store.saveCheckinStatus(id, status, connection.connectionVersion);
    return status;
  } finally { release(); }
}
export async function submitCheckin(store: Store, id: string, route: QueryRouteMode, refreshBalance: boolean, balanceBusy: (id: string) => boolean = () => false, expectedVersion?: string): Promise<CheckinResult> {
  const { connection, skip } = capture(store, id);
  if (skip || !connection) return empty(id, skip || "missing");
  if (expectedVersion !== undefined && connection.connectionVersion !== expectedVersion) return empty(id, "changed");
  const identity = checkinIdentity(connection.account), site = checkinSite(connection.account);
  const release = balanceBusy(id) ? null : acquire(store, id, identity, site);
  if (!release) return empty(id, "busy");
  const version = connection.connectionVersion;
  let status: CheckinStatus | null = null;
  function finish(outcome: CheckinOutcome, reward: { date: string; quotaAwarded: number } | null = null): CheckinResult {
    if (!unchanged(store, id, version)) return empty(id, "changed");
    const operation = checkinOperationSchema.parse({ id: randomUUID(), accountId: id, at: new Date().toISOString(), outcome, message: M[outcome], date: reward?.date ?? null, quotaAwarded: reward?.quotaAwarded ?? null });
    store.saveCheckinOperation(id, operation, version);
    if (status) store.saveCheckinStatus(id, status, version);
    return { accountId: id, outcome, message: M[outcome], status, operation };
  }
  try {
    const reader = createCheckinReader(connection.account, connection.credential!, id, route);
    status = await reader.status();
    if (!unchanged(store, id, version)) return empty(id, "changed");
    if (store.hasCheckinBarrier(identity)) {
      if (status.checkedInToday === true) { store.clearCheckinBarrier(identity); return finish("already_signed"); }
      status = { ...status, state: "uncertain", message: M.uncertain };
      return finish("uncertain");
    }
    if (status.state !== "unsigned" || status.enabled !== true || status.checkedInToday !== false)
      return finish(status.state === "signed" ? "already_signed" : status.state === "unsigned" ? "failed" : status.state);
    // Durable across process restarts and duplicate account cards. This commit
    // precedes the only external POST. Alias/group changes preserve its identity.
    if (!store.beginCheckinBarrier(id, identity, version)) return finish(unchanged(store, id, version) ? "uncertain" : "changed");
    let reward: { date: string; quotaAwarded: number };
    try {
      reward = await reader.submit();
      // Validate the derived public status BEFORE clearing the durable barrier.
      const sameMonth = status.month === reward.date.slice(0, 7);
      const records = sameMonth ? status.records.filter(r => r.date !== reward.date).concat(reward) : [reward];
      status = checkinStatusSchema.parse({ ...status, readAt: new Date().toISOString(), month: reward.date.slice(0, 7), monthSource: "site", state: "signed", enabled: true, checkedInToday: true, records: records.sort((a, b) => a.date.localeCompare(b.date)), monthCount: records.length, totalCheckins: status.totalCheckins === null ? null : status.totalCheckins + 1, totalQuota: status.totalQuota === null ? null : status.totalQuota + reward.quotaAwarded, message: M.signed });
    } catch (error) {
      if (knownSubmissionFailure(error)) {
        store.clearCheckinBarrier(identity);
        if (error instanceof CheckinBusinessFailure && error.reason === "signed") {
          status = { ...status, state: "signed", checkedInToday: true, message: M.signed };
          return finish("already_signed");
        }
        const state = checkinErrorState(error);
        status = { ...status, state, message: M[state] };
        return finish(state);
      }
      status = { ...status, state: "uncertain", message: M.uncertain };
      return finish("uncertain");
    }
    store.clearCheckinBarrier(identity);
    const result = finish("success", reward);
    if (result.outcome !== "success" || !refreshBalance) return result;
    try {
      const { result: balance, diagnostic } = await queryBalance(connection.account, connection.credential, "sync", route, reader.deadline);
      if (!unchanged(store, id, version)) return { ...result, balanceRefresh: { outcome: "failed", message: "余额未刷新：账号连接配置已改变。" } };
      store.record(id, balance.balance, "sync", balance.unit, "签到后接口同步", balance.rawQuota, diagnostic);
      return { ...result, account: store.get(id)!, balanceRefresh: { outcome: "success", message: "已通过额外查询刷新余额。" } };
    } catch { return { ...result, balanceRefresh: { outcome: "failed", message: "签到已成功；额外余额查询失败，保留原余额。" } }; }
  } finally { release(); }
}
export async function batchCheckin(store: Store, ids: string[], route: QueryRouteMode, refreshBalance: boolean, balanceBusy: (id: string) => boolean = () => false) {
  const identities = new Set<string>(), queues = new Map<string, string[]>(), results = new Map<string, CheckinResult>();
  const versions = new Map<string, string>();
  // Freeze the explicit caller range; neither saved filters nor subsequent
  // account creation can expand the requested set.
  for (const id of ids) {
    const { connection, skip } = capture(store, id);
    if (skip || !connection) { results.set(id, empty(id, skip || "missing")); continue; }
    const identity = checkinIdentity(connection.account), site = checkinSite(connection.account);
    if (identities.has(identity)) { results.set(id, empty(id, "duplicate")); continue; }
    identities.add(identity);
    versions.set(id, connection.connectionVersion);
    const queue = queues.get(site) || []; queue.push(id); queues.set(site, queue);
  }
  const pending = [...queues.values()];
  async function worker() {
    while (pending.length) {
      const group = pending.shift()!;
      for (const id of group) {
        try { results.set(id, await submitCheckin(store, id, route, refreshBalance, balanceBusy, versions.get(id))); }
        catch { results.set(id, empty(id, "failed")); }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
  return { results: ids.map(id => results.get(id) || empty(id, "failed")) };
}
