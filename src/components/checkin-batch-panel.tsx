"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarCheck, LoaderCircle } from "lucide-react";
import type { Account } from "@/lib/validation";
import type { QueryRouteMode } from "@/lib/query-routing";
import type { CheckinResult } from "@/lib/checkin";
import type { Send } from "./account-form";
import { blockedCheckinReason, checkinLabel, CheckinResultView, readCheckinCache, readCheckinResult } from "./checkin-panel";
import { Modal } from "./modal";

// A preview is a snapshot, including ineligible accounts. Sending every frozen
// ID lets the server report skips and recheck signed status on the current day.
export function CheckinBatchPanel({ accounts, scope, send, routeMode, routingBusy, onClose }: { accounts: readonly Account[]; scope: "selected" | "filtered"; send: Send; routeMode: QueryRouteMode | null; routingBusy: boolean; onClose: () => void }) {
  const [frozen] = useState(() => accounts.map((account) => ({ ...account }))), [refreshBalance, setRefreshBalance] = useState(false);
  const [busy, setBusy] = useState(false), [results, setResults] = useState<CheckinResult[] | null>(null), [error, setError] = useState("");
  const [cachedStates, setCachedStates] = useState<Record<string, "signed" | "uncertain" | "unknown">>({});
  const inFlight = useRef(false), alive = useRef(true), generation = useRef(0);
  const validRange = frozen.length > 0 && frozen.length <= 500;
  const resultById = new Map((results ?? []).map((result) => [result.accountId, result]));
  const counts = new Map<string, number>();
  for (const result of results ?? []) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  const preview = frozen.map((account) => ({ account, reason: blockedCheckinReason(account) }));
  useEffect(() => {
    alive.current = true;
    const ticket = ++generation.current;
    const eligible = validRange ? frozen.filter((account) => !blockedCheckinReason(account)) : [];
    let next = 0;
    const current = () => alive.current && ticket === generation.current;
    async function readNext() {
      while (current() && next < eligible.length) {
        const account = eligible[next++];
        let state: "signed" | "uncertain" | "unknown" = "unknown";
        try {
          const cache = readCheckinCache(await send<unknown>(`accounts/${account.id}/checkin`), account.id);
          state = cache.uncertain ? "uncertain" : cache.status?.state === "signed" ? "signed" : "unknown";
        } catch { /* Missing or invalid local cache leaves status unknown. */ }
        if (!current()) return;
        setCachedStates((old) => ({ ...old, [account.id]: state }));
      }
    }
    for (let worker = 0; worker < Math.min(3, eligible.length); worker++) void readNext();
    return () => { alive.current = false; generation.current++; };
  }, [frozen, send, validRange]);

  async function start() {
    if (inFlight.current || !validRange || routingBusy || routeMode === null || results !== null) return;
    const ticket = ++generation.current;
    inFlight.current = true; setBusy(true); setError("");
    const capturedRoute = routeMode;
    try {
      const data = await send<{ results: unknown[] }>("checkin/batch", "POST", { ids: frozen.map((account) => account.id), refreshBalance, routeMode: capturedRoute });
      if (!alive.current || ticket !== generation.current) return;
      if (!Array.isArray(data.results) || data.results.length !== frozen.length) throw new Error("invalid batch result");
      const byId = new Map(frozen.map((account) => [account.id, account]));
      const responseIds = new Set<string>();
      const parsed = data.results.map((value) => {
        if (!value || typeof value !== "object") throw new Error("invalid batch result");
        const id = (value as { accountId?: unknown }).accountId;
        if (typeof id !== "string" || !byId.has(id) || responseIds.has(id)) throw new Error("invalid batch account");
        responseIds.add(id); return readCheckinResult(value, id);
      });
      setResults(parsed);
    } catch {
      if (!alive.current || ticket !== generation.current) return;
      // An HTTP response lost after the batch began cannot authorize a replay.
      setError("批量结果待确认。请逐个查询签到状态或到站点确认；关闭后重新打开只会读取本地记录。");
      setResults([]);
    } finally { if (alive.current && ticket === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  const close = () => { alive.current = false; generation.current++; onClose(); };
  return <Modal open wide closeDisabled={busy} onClose={close} title="批量签到" description="先预览范围，再逐个核对站点今日状态并签到。不会自动重试提交，奖励按各站点单位单独展示。">
    <div className="checkin-batch-panel" data-testid="checkin-batch-panel">
      <div className="checkin-batch-scope"><strong>{scope === "selected" ? "已选账号" : "当前筛选账号"} · {frozen.length} 个</strong><span>范围已固定，执行中不随筛选变化</span></div>
      {!validRange && <p className="checkin-error" role="alert">{frozen.length === 0 ? "此范围没有账号。" : "一次最多 500 个账号，请缩小选择或筛选范围。"}</p>}
      <label className="checkin-refresh-option"><input type="checkbox" checked={refreshBalance} disabled={busy || results !== null} onChange={(event) => setRefreshBalance(event.target.checked)} />成功后刷新余额</label>
      <p className="checkin-help">勾选后，每个签到成功的账号会额外查询余额。已签账号在执行时重新核对；账号身份由服务器核对，关闭、归档、缺少凭据或用户 ID、重复身份会分别列出原因。{routingBusy || routeMode === null ? "查询线路准备中。" : `点击开始时使用${routeMode === "proxy" ? "代理" : "直连"}线路。`}</p>
      {error && <p className="checkin-error" role="alert">{error}</p>}
      {results !== null && results.length > 0 && <div className="checkin-batch-summary" role="status">{[...counts].map(([outcome, count]) => <span key={outcome}>{checkinLabel[outcome as CheckinResult["outcome"]]} {count} 个</span>)}</div>}
      <ul className="checkin-batch-list" aria-label="批量签到账号与结果">{preview.map(({ account, reason }) => {
        const result = resultById.get(account.id);
        return <li key={account.id}><div className="checkin-batch-account"><strong>{account.name}</strong><span>{account.alias || account.group || "未分组"}</span></div>{result ? <CheckinResultView result={result} conversion={account} /> : <p>{busy ? "正在逐个处理，等待结果…" : results !== null ? "结果待确认，请查询状态。" : reason || (cachedStates[account.id] === "signed" ? "缓存已签，执行时再次核对" : cachedStates[account.id] === "uncertain" ? "缓存结果待确认，执行时再次核对；不会重复提交。" : "状态未知，执行时先核对今日状态；未签到才提交。")}</p>}</li>;
      })}</ul>
      <p className="checkin-help">奖励按各站点单位分别展示，不合计不同站点的配额。</p>
      <div className="checkin-batch-actions"><button type="button" className="button" disabled={busy} onClick={close}>{results === null ? "取消" : "完成"}</button><button type="button" className="button primary" disabled={busy || !validRange || routingBusy || routeMode === null || results !== null} onClick={() => void start()}>{busy ? <LoaderCircle size={16} className="spin" /> : <CalendarCheck size={16} />}{busy ? "正在签到…" : "开始签到"}</button></div>
    </div>
  </Modal>;
}
