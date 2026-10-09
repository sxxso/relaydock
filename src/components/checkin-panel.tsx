"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CalendarCheck, Check, ExternalLink, RefreshCw } from "lucide-react";
import type { Account } from "@/lib/validation";
import type { QueryRouteMode } from "@/lib/query-routing";
import { checkinReward, checkinRewardRange } from "@/lib/checkin-display";
import {
  checkinMessages, checkinOperationSchema, checkinOutcomeSchema, checkinStatusSchema, monthSchema,
  type CheckinOperation, type CheckinOutcome, type CheckinResult, type CheckinStatus,
} from "@/lib/checkin";
import type { Send } from "./account-form";
import { Modal } from "./modal";
import "./checkin-panel.css";

const numeric = (value: number | null) => value === null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 12 });
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const localMonth = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`; };
export const checkinLabel: Record<CheckinOutcome | "unsigned" | "signed", string> = {
  unsigned: "今日未签到", signed: "今日已签到", success: "签到成功", already_signed: "今日已签到，已跳过",
  disabled: "签到已关闭", unsupported: "不支持标准签到", needs_web: "需要到网页完成", failed: "操作失败",
  uncertain: "结果待确认", busy: "正在操作，已跳过", duplicate: "重复身份，已跳过",
  missing_credential: "缺少管理凭据", missing_identity: "缺少用户 ID", archived: "已归档，已跳过",
  changed: "连接已改变", missing: "账号不存在",
};

export function quotaText(value: number | null, conversion: { quotaPerUnit: string | null; unit: string }) {
  return value === null ? "—" : checkinReward(value, conversion).detail;
}

export function blockedCheckinReason(account: Account) {
  if (account.archived) return "此账号已归档，可查看本地记录；取消归档后才能签到。";
  if (account.provider !== "newapi") return "目前仅支持 New API 账户管理模板。";
  if (!account.hasCredential) return "缺少账户管理凭据，请在编辑档案中填写管理 PAT。";
  if (!account.userId) return "缺少用户 ID，请在编辑档案中填写后再查询或签到。";
  return "";
}

// Render only the client-safe contract and fixed outcome copy. Account updates
// are handled by Workspace's session-checked send wrapper, even after closing.
export function readCheckinResult(value: unknown, accountId: string): CheckinResult {
  if (!value || typeof value !== "object") throw new Error("invalid checkin result");
  const v = value as Record<string, unknown>;
  const outcome = checkinOutcomeSchema.parse(v.outcome);
  if (v.accountId !== accountId) throw new Error("wrong checkin account");
  const status = v.status === null ? null : checkinStatusSchema.parse(v.status);
  const operation = v.operation === null ? null : checkinOperationSchema.parse(v.operation);
  if ((status && status.accountId !== accountId) || (operation && operation.accountId !== accountId)) throw new Error("wrong checkin account");
  const balance = v.balanceRefresh as { outcome?: unknown } | undefined;
  return {
    accountId, outcome, message: checkinMessages[outcome], status, operation,
    ...(balance?.outcome === "success" || balance?.outcome === "failed" ? { balanceRefresh: { outcome: balance.outcome, message: balance.outcome === "success" ? "余额已刷新。" : "签到结果已保留，余额刷新失败；可单独刷新余额。" } } : {}),
  };
}

export function readCheckinCache(value: unknown, accountId: string, month?: string) {
  if (!value || typeof value !== "object") throw new Error("invalid checkin cache");
  const v = value as Record<string, unknown>;
  const status = v.status === null ? null : checkinStatusSchema.parse(v.status);
  if (status && (status.accountId !== accountId || (month && status.month !== month))) throw new Error("wrong checkin cache");
  if (!Array.isArray(v.operations) || v.operations.length > 100 || typeof v.uncertain !== "boolean") throw new Error("invalid checkin cache");
  const operations = v.operations.map((operation) => checkinOperationSchema.parse(operation));
  if (operations.some((operation) => operation.accountId !== accountId)) throw new Error("wrong checkin operations");
  return { status, operations, uncertain: v.uncertain };
}

function Calendar({ month, data }: { month: string; data: CheckinStatus | null }) {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  const records = new Map((data?.records ?? []).map((record) => [record.date, record.quotaAwarded]));
  const filled = Array.from({ length: offset + days }, (_, index) => index < offset ? null : index - offset + 1);
  while (filled.length % 7) filled.push(null);
  return <section className="checkin-calendar-section" aria-label={`${month} 签到月历`}>
    <div className="checkin-calendar-title"><h3>{month} 月历</h3><span><i />站点签到记录</span></div>
    <div className="checkin-calendar" data-testid="checkin-calendar" role="table" aria-label={`${month} 站点签到日期`}>
      <div role="row" className="checkin-weekdays">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span role="columnheader" key={day}>周{day}</span>)}</div>
      {Array.from({ length: filled.length / 7 }, (_, week) => <div role="row" className="checkin-calendar-week" key={week}>{filled.slice(week * 7, week * 7 + 7).map((day, column) => {
        if (day === null) return <div className="checkin-day empty" role="cell" aria-label="本月以外" key={column} />;
        const date = `${month}-${String(day).padStart(2, "0")}`, quota = records.get(date);
        const reward = quota === undefined ? null : checkinReward(quota, data!);
        return <div role="cell" key={column} className={`checkin-day ${reward ? "stamped" : ""}`} aria-label={reward ? `${date}，已签到，${reward.detail}` : `${date}，无返回记录`} title={reward?.detail}>
          <div className="checkin-day-heading"><span className="checkin-day-number">{day}</span>{reward && <Check size={13} aria-hidden="true" />}</div>
          {reward && <span className="checkin-day-quota" title={reward.detail}>{reward.primary}</span>}
        </div>;
      })}</div>)}
    </div>
    <p className="checkin-help">日期按站点返回值显示；空白日表示没有返回记录，不代表漏签。奖励按本站配额换算，未设置有效换算时显示原始配额；完整金额和原始值可在下方记录中查看。</p>
    {data && <ul className="checkin-records" aria-label="本月签到日期与奖励">{data.records.map((record) => <li key={record.date}><time dateTime={record.date}>{record.date}</time><span>{quotaText(record.quotaAwarded, data)}</span></li>)}</ul>}
  </section>;
}

export function CheckinResultView({ result, conversion }: { result: CheckinResult; conversion: { quotaPerUnit: string | null; unit: string } }) {
  return <div className={`checkin-feedback ${result.outcome === "success" || result.outcome === "already_signed" ? "positive" : ""}`} role="status">
    <strong>{checkinLabel[result.outcome]}</strong><p>{result.message}</p>
    {result.operation?.date && <p><time dateTime={result.operation.date}>{result.operation.date}</time>{" · "}{quotaText(result.operation.quotaAwarded, result.status ?? conversion)}</p>}
    {result.balanceRefresh && <p className={result.balanceRefresh.outcome === "failed" ? "checkin-balance-error" : ""}>{result.balanceRefresh.message}</p>}
  </div>;
}

export function CheckinPanel({ account, send, routeMode, routingBusy, onClose }: { account: Account; send: Send; routeMode: QueryRouteMode | null; routingBusy: boolean; onClose: () => void }) {
  const [month, setMonth] = useState(localMonth), [status, setStatus] = useState<CheckinStatus | null>(null), [calendar, setCalendar] = useState<CheckinStatus | null>(null);
  const [operations, setOperations] = useState<CheckinOperation[]>([]), [uncertain, setUncertain] = useState(false), [refreshBalance, setRefreshBalance] = useState(false);
  const [pending, setPending] = useState<"cache" | "query" | "signin" | null>("cache"), [error, setError] = useState(""), [result, setResult] = useState<CheckinResult | null>(null);
  const [readSource, setReadSource] = useState<"cache" | "site">("cache");
  const alive = useRef(true), generation = useRef(0), inFlight = useRef(true), selectedMonth = useRef(month);
  selectedMonth.current = month;
  const blocked = blockedCheckinReason(account), busy = pending !== null;
  const canQuery = !blocked && !routingBusy && routeMode !== null && !busy;
  const state = uncertain ? "uncertain" : status?.state;
  const canSign = canQuery && !uncertain && (!status || status.state === "unsigned");
  const oldCalendar = calendar !== null && status !== calendar;
  const siteLink = (() => { try { const u = new URL(account.consoleUrl || account.siteUrl); return ["http:", "https:"].includes(u.protocol) ? u.toString() : null; } catch { return null; } })();

  useEffect(() => {
    alive.current = true; inFlight.current = true;
    const ticket = ++generation.current;
    setPending("cache"); setError(""); setStatus(null); setCalendar(null); setOperations([]); setUncertain(false); setResult(null); setRefreshBalance(false); setReadSource("cache");
    void send<unknown>(`accounts/${account.id}/checkin`).then((response) => {
      if (!alive.current || ticket !== generation.current) return;
      const data = readCheckinCache(response, account.id);
      setStatus(data.status); setCalendar(data.status); setOperations(data.operations); setUncertain(data.uncertain);
      if (data.status) { setMonth(data.status.month); selectedMonth.current = data.status.month; }
    }).catch(() => { if (alive.current && ticket === generation.current) setError("本地签到缓存读取失败，请重新打开面板。"); })
      .finally(() => { if (alive.current && ticket === generation.current) { inFlight.current = false; setPending(null); } });
    return () => { alive.current = false; generation.current++; };
  }, [account.id, send]);

  async function changeMonth(next: string) {
    if (inFlight.current || !monthSchema.safeParse(next).success) return;
    setMonth(next); selectedMonth.current = next; setStatus(null); setCalendar(null); setError(""); setResult(null); setReadSource("cache");
    const ticket = ++generation.current; inFlight.current = true; setPending("cache");
    try {
      const data = readCheckinCache(await send<unknown>(`accounts/${account.id}/checkin?month=${next}`), account.id, next);
      if (!alive.current || ticket !== generation.current) return;
      setStatus(data.status); setCalendar(data.status); setOperations(data.operations); setUncertain(data.uncertain);
    } catch { if (alive.current && ticket === generation.current) setError("本月本地缓存读取失败，请重新打开面板。"); }
    finally { if (alive.current && ticket === generation.current) { inFlight.current = false; setPending(null); } }
  }

  async function query() {
    if (!canQuery || inFlight.current) return;
    const ticket = ++generation.current, choice = month, capturedRoute = routeMode;
    inFlight.current = true; setPending("query"); setError(""); setResult(null);
    try {
      const data = checkinStatusSchema.parse(await send<unknown>(`accounts/${account.id}/checkin/status`, "POST", { month: choice, routeMode: capturedRoute }));
      if (data.accountId !== account.id || data.month !== choice) throw new Error("wrong checkin status");
      if (!alive.current || ticket !== generation.current || selectedMonth.current !== choice) return;
      setStatus(data);
      setReadSource("site");
      if (["unsigned", "signed"].includes(data.state)) setCalendar(data);
      else if (!calendar || calendar.month !== choice) setCalendar(data);
      if (data.checkedInToday === true) setUncertain(false);
      else if (data.state === "uncertain") setUncertain(true);
    } catch { if (alive.current && ticket === generation.current) setError("签到状态查询失败，保留本月旧缓存；请核对站点和管理凭据。"); }
    finally { if (alive.current && ticket === generation.current) { inFlight.current = false; setPending(null); } }
  }

  async function signin() {
    if (!canSign || inFlight.current) return;
    const ticket = ++generation.current, capturedRoute = routeMode;
    inFlight.current = true; setPending("signin"); setError(""); setResult(null);
    try {
      const data = readCheckinResult(await send<unknown>(`accounts/${account.id}/checkin`, "POST", { refreshBalance, routeMode: capturedRoute }), account.id);
      if (!alive.current || ticket !== generation.current) return;
      setResult(data);
      if (data.status) {
        setStatus(data.status);
        setReadSource("site");
        if (data.status.month === selectedMonth.current && ["unsigned", "signed"].includes(data.status.state)) setCalendar(data.status);
      }
      if (data.outcome === "uncertain") setUncertain(true);
      else if (data.status?.checkedInToday === true) setUncertain(false);
      if (data.operation) setOperations((old) => [data.operation!, ...old.filter((operation) => operation.id !== data.operation!.id)].slice(0, 100));
    } catch {
      if (alive.current && ticket === generation.current) { setUncertain(true); setError("签到结果待确认；请查询状态或到站点确认，不会重复提交。"); }
    } finally { if (alive.current && ticket === generation.current) { inFlight.current = false; setPending(null); } }
  }

  const close = () => { alive.current = false; generation.current++; onClose(); };
  return <Modal open wide onClose={close} title={`签到与月历 · ${account.name}`} description="点击时查询或签到。日期和奖励以站点返回值为准；批量操作也会先核对今日状态。">
    <div className="checkin-panel" data-testid="checkin-panel">
      <p className="checkin-account-name">{account.name}{account.alias && ` · ${account.alias}`}</p>
      <div className="checkin-controls"><label className="checkin-month-label"><span>签到月份</span><input type="month" aria-label="签到月份" value={month} disabled={busy} onChange={(event) => void changeMonth(event.target.value)} /></label>
        <button type="button" className="button" disabled={!canQuery} onClick={() => void query()}><RefreshCw size={15} className={pending === "query" ? "spin" : ""} />查询签到状态</button>
        <button type="button" className="button primary" disabled={!canSign} onClick={() => void signin()}><CalendarCheck size={16} />立即签到</button>
      </div>
      <label className="checkin-refresh-option"><input type="checkbox" checked={refreshBalance} disabled={busy} onChange={(event) => setRefreshBalance(event.target.checked)} />成功后刷新余额</label>
      <p className="checkin-help">勾选后，签到成功会额外查询一次余额并记录快照。{blocked || (routingBusy || routeMode === null ? "查询线路准备中。" : `本次点击使用${routeMode === "proxy" ? "代理" : "直连"}线路。`)}</p>
      {error && <div role="alert" className="checkin-error"><AlertCircle size={16} /><p>{error}</p></div>}
      {pending === "cache" ? <p role="status" className="checkin-empty">正在读取本地签到缓存…</p> : <>
        <section className={`checkin-status ${state === "signed" ? "signed" : state === "uncertain" ? "uncertain" : ""}`} aria-label="签到状态">
          <div><strong>{state === "signed" && readSource === "cache" ? "缓存显示已签到" : state ? checkinLabel[state] : "未读取"}</strong><p>{uncertain ? "签到结果待确认；请查询状态或到站点确认，不会重复提交。" : status?.message ?? "还没有本站的签到状态。先查状态；直接签到也会先核对今日是否已签。"}</p>{state === "signed" && readSource === "cache" && <p className="checkin-help">缓存可能已过期，请点击“查询签到状态”确认今日签到情况。</p>}</div>
          {status && <dl><div><dt>读取来源</dt><dd>{readSource === "cache" ? "本地缓存" : "本次站点读取"}</dd></div><div><dt>读取时间</dt><dd><time dateTime={status.readAt}>{time(status.readAt)}</time></dd></div><div><dt>数据月份</dt><dd>{status.month} · {status.monthSource === "site" ? "站点返回日期" : status.monthSource === "requested" ? "所选月份" : "客户端月份（站点未返回日期）"}</dd></div></dl>}
        </section>
        {result && <CheckinResultView result={result} conversion={account} />}
        {(state === "needs_web" || state === "uncertain") && siteLink && <a className="button checkin-site-link" href={siteLink} target="_blank" rel="noopener noreferrer">到站点确认<ExternalLink size={14} /></a>}
        {status && status.state !== "unsigned" && status.state !== "signed" && !uncertain && <p className="checkin-help">查询状态确认可以签到后，“立即签到”才会启用。</p>}
        {calendar && calendar.month === month && <dl className="checkin-totals"><div><dt>本月记录次数</dt><dd>{numeric(calendar.monthCount)}</dd></div><div><dt>累计签到次数</dt><dd>{numeric(calendar.totalCheckins)}</dd></div><div><dt>累计奖励（全部月份）</dt><dd>{quotaText(calendar.totalQuota, calendar)}</dd></div><div><dt>本站奖励范围</dt><dd>{checkinRewardRange(calendar.minQuota, calendar.maxQuota, calendar)}</dd></div></dl>}
        {(oldCalendar || (error && calendar)) && calendar?.month === month && <p className="checkin-old-cache" role="status">以下月历是旧缓存，读取于 {time(calendar.readAt)}；本次结果未替换它。</p>}
        <Calendar month={month} data={calendar?.month === month ? calendar : null} />
        <section className="checkin-operations" aria-label="最近签到操作"><h3>最近操作</h3>{operations.length === 0 ? <p className="checkin-help">尚无本地签到操作记录。</p> : <ul>{operations.map((operation) => <li key={operation.id}><div><strong>{checkinLabel[operation.outcome]}</strong><time dateTime={operation.at}>{time(operation.at)}</time></div><p>{operation.message}</p>{operation.date && <p>{operation.date} · {quotaText(operation.quotaAwarded, account)}</p>}</li>)}</ul>}</section>
      </>}
    </div>
  </Modal>;
}
