import type { Account } from "./validation";
import { normalizeDiagnostic, type QueryDiagnostic } from "./query-diagnostics";
export type BalanceFreshness = {
  hasBalance: boolean;
  sourceLabel: string;
  amountLabel: string;
  recordedAt: string | null;
  absoluteTime: string | null;
  ageLabel: string;
  queryLabel: string;
  queryAt: string | null;
  queryFailed: boolean;
  testLabel: string | null;
  testAt: string | null;
  testFailed: boolean;
  mapLabel: string;
  accessibleLabel: string;
};
export function compareRecordedAt(
  a: Pick<Account, "lastSnapshotAt">,
  b: Pick<Account, "lastSnapshotAt">,
): number {
  const instant = (at: string | null) => {
    const ms = at ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  const difference = instant(b.lastSnapshotAt) - instant(a.lastSnapshotAt);
  return Number.isNaN(difference) ? 0 : difference;
}
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
export function absoluteRecordTime(at: string | null): string | null {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? dateFormatter.format(ms) : null;
}
function age(at: string | null, now: number) {
  const ms = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return "记录时间未知";
  const delta = now - ms;
  if (delta < 0) return "记录时间晚于当前设备";
  if (delta < 60000) return "刚刚记录";
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前记录`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前记录`;
  return `${Math.floor(delta / 86400000)} 天前记录`;
}
function failureReason(d: QueryDiagnostic | null) {
  if (!d || d.outcome !== "failure") return "失败";
  if (d.code.endsWith("_timeout")) return "超时";
  return {
    network: "网络失败",
    auth: "被拒绝（401/403）",
    compatibility: "接口不兼容",
    "rate-limit": "被限流",
    service: "失败",
    security: "被安全规则拦截",
    configuration: "配置未完成",
    success: "失败",
  }[d.category];
}
export function balanceFreshness(
  account: Account,
  now: number,
): BalanceFreshness {
  const hasBalance = account.balance !== null;
  const sourceLabel = !hasBalance
    ? "尚无余额记录"
    : account.balanceSource === "manual"
      ? "手动记录"
      : account.balanceSource === "sync"
        ? "接口查询"
        : "来源未知";
  const absoluteTime = hasBalance
    ? absoluteRecordTime(account.lastSnapshotAt)
    : null;
  const recordedAt = absoluteTime ? account.lastSnapshotAt : null;
  const ageLabel = hasBalance ? age(recordedAt, now) : "尚未记录";
  const queryFailed = account.lastSyncStatus === "error";
  const candidate = normalizeDiagnostic(account.lastSyncDiagnostic);
  // A recent test must never replace the classification of a failed refresh.
  // Legacy diagnostics are used only when they actually match that attempt.
  const syncAt = account.lastSyncAt ? Date.parse(account.lastSyncAt) : NaN;
  const syncDiagnostic =
    candidate?.operation === "sync" &&
    candidate.outcome === "failure" &&
    candidate.finishedAt === account.lastSyncAt
      ? candidate
      : null;
  const queryLabel = queryFailed
    ? "最近查询" + failureReason(syncDiagnostic)
    : account.lastSyncStatus === "success"
      ? "最近查询成功"
      : account.balanceSource === "sync"
        ? "尚无查询结果"
        : "尚未查询余额";
  const queryAt =
    account.lastSyncStatus !== "never" && absoluteRecordTime(account.lastSyncAt)
      ? account.lastSyncAt
      : null;
  const latest = normalizeDiagnostic(account.lastQueryDiagnostic);
  const test =
    latest?.operation === "test" &&
    (!Number.isFinite(syncAt) || Date.parse(latest.finishedAt) >= syncAt)
      ? latest
      : null;
  const testLabel = test
    ? `连接测试${test.outcome === "success" ? "成功" : failureReason(test)}（未更新余额）`
    : null;
  const testAt = test?.finishedAt ?? null;
  const testFailed = test?.outcome === "failure";
  const amountLabel = !hasBalance
    ? "余额未知"
    : queryFailed
      ? "上次余额"
      : "已记录余额";
  const shortAge = ageLabel.replaceAll(" ", "").replace("记录", "");
  const shortSource =
    account.balanceSource === "manual"
      ? "手动"
      : account.balanceSource === "sync"
        ? "接口"
        : "来源?";
  const mapWarning = queryFailed
    ? syncDiagnostic?.code.endsWith("_timeout")
      ? "超时"
      : "查询失败"
    : testFailed
      ? "测试失败"
      : null;
  const mapLabel = [
    hasBalance ? `${shortSource} · ${shortAge}` : "未记录",
    mapWarning,
  ]
    .filter(Boolean)
    .join(" · ");
  const accessibleLabel = [
    amountLabel,
    sourceLabel,
    absoluteTime ? `${ageLabel}，记录于 ${absoluteTime}` : ageLabel,
    queryLabel,
    queryAt ? `查询于 ${absoluteRecordTime(queryAt)}` : null,
    testLabel,
    testAt ? `测试于 ${absoluteRecordTime(testAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    hasBalance,
    sourceLabel,
    amountLabel,
    recordedAt,
    absoluteTime,
    ageLabel,
    queryLabel,
    queryAt,
    queryFailed,
    testLabel,
    testAt,
    testFailed,
    mapLabel,
    accessibleLabel,
  };
}
export type RecordClockHost = {
  now: () => number;
  visible: () => boolean;
  schedule: (callback: () => void, delay: number) => () => void;
  subscribe: (callback: () => void) => () => void;
};
export function watchRecordClock(
  notify: (now: number) => void,
  host: RecordClockHost,
): () => void {
  let stopped = false,
    cancel: (() => void) | undefined;
  const update = () => {
    cancel?.();
    cancel = undefined;
    if (stopped || !host.visible()) return;
    const now = host.now();
    notify(now);
    cancel = host.schedule(update, 60000 - (now % 60000));
  };
  const unsubscribe = host.subscribe(update);
  update();
  return () => {
    stopped = true;
    cancel?.();
    cancel = undefined;
    unsubscribe();
  };
}
