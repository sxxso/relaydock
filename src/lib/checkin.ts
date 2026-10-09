import { z } from "zod";

// Client-safe contract. Provider messages, IDs and bodies never cross it.
export const monthSchema = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/);
export const dateSchema = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).refine(v => {
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
});
const number = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = number.int();
const id = z.string().min(1).max(100);
export const checkinMessages = {
  unsigned: "站点确认今日尚未签到。",
  signed: "站点确认今日已签到。",
  success: "签到成功；奖励以站点日期和原始配额为准。",
  disabled: "站点关闭了签到功能。",
  unsupported: "站点没有标准签到接口（HTTP 404）。",
  needs_web: "站点要求网页登录或验证；请到站点完成。",
  failed: "签到接口读取或业务操作失败；请核对站点和管理凭据。",
  uncertain: "签到结果待确认；不会重复提交，请到站点确认。",
  busy: "此账号或同站点身份正在操作，请等待完成。",
  duplicate: "同站点、同用户的重复账号已跳过。",
  missing_credential: "缺少账户管理凭据；无法签到。",
  missing_identity: "签到需要填写用户 ID，以确认同站点账号身份。",
  archived: "归档账号已跳过。",
  changed: "账号连接配置已改变；旧结果未写入，请重新查询。",
  missing: "账号不存在；已跳过。",
  already_signed: "站点确认今日已签到；已跳过提交。",
} as const;
const message = z.enum(Object.values(checkinMessages) as [string, ...string[]]);
export const checkinStateSchema = z.enum(["unsigned", "signed", "disabled", "unsupported", "needs_web", "failed", "uncertain"]);
export const checkinOutcomeSchema = z.enum(["success", "already_signed", "disabled", "unsupported", "needs_web", "failed", "uncertain", "busy", "duplicate", "missing_credential", "missing_identity", "archived", "changed", "missing"]);
const recordSchema = z.object({ date: dateSchema, quotaAwarded: number }).strict();
export const checkinStatusSchema = z.object({
  version: z.literal(1), accountId: id, readAt: z.iso.datetime(), month: monthSchema,
  monthSource: z.enum(["site", "requested", "client"]), state: checkinStateSchema,
  enabled: z.boolean().nullable(), checkedInToday: z.boolean().nullable(),
  minQuota: number.nullable(), maxQuota: number.nullable(), records: z.array(recordSchema).max(31),
  monthCount: count.nullable(), totalCheckins: count.nullable(), totalQuota: number.nullable(),
  quotaPerUnit: z.string().regex(/^\d+(?:\.\d+)?$/).refine(v => Number(v) > 0 && Number.isFinite(Number(v))).nullable(),
  unit: z.string().min(1).max(20).refine(v => !/[\u0000-\u001f\u007f]/.test(v)), message,
}).strict().refine(s => new Set(s.records.map(r => r.date)).size === s.records.length && s.records.every(r => r.date.startsWith(s.month + "-")))
  .refine(s => (s.monthCount === null || s.monthCount === s.records.length) && (s.totalCheckins === null || s.totalCheckins >= s.records.length) && (s.totalQuota === null || s.totalQuota >= s.records.reduce((n, r) => n + r.quotaAwarded, 0)))
  .refine(s => s.minQuota === null || s.maxQuota === null || s.minQuota <= s.maxQuota)
  .refine(s => s.state !== "unsigned" || (s.enabled === true && s.checkedInToday === false))
  .refine(s => s.state !== "signed" || s.checkedInToday === true);
export const checkinOperationSchema = z.object({ id, accountId: id, at: z.iso.datetime(), outcome: checkinOutcomeSchema, message, date: dateSchema.nullable(), quotaAwarded: number.nullable() }).strict();
export type CheckinStatus = z.infer<typeof checkinStatusSchema>;
export type CheckinOperation = z.infer<typeof checkinOperationSchema>;
export type CheckinOutcome = z.infer<typeof checkinOutcomeSchema>;
export type CheckinResult = { accountId: string; outcome: CheckinOutcome; message: string; status: CheckinStatus | null; operation: CheckinOperation | null; account?: import("./validation").Account; balanceRefresh?: { outcome: "success" | "failed"; message: string } };
export type CheckinContext = { accountId: string; requestedMonth?: string; quotaPerUnit: string | null; unit: string; readAt?: string };
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid checkin response");
  return v as Record<string, unknown>;
}
export class CheckinBusinessFailure extends Error {
  constructor(readonly reason: "failed" | "disabled" | "signed" | "needs_web" = "failed") { super("checkin business failure"); }
}
function data(body: unknown) {
  const root = object(body);
  if (root.success === false) {
    // Interpret a small set of standard business outcomes without retaining or
    // returning the provider's arbitrary message (which can echo credentials).
    const message = typeof root.message === "string" ? root.message : "";
    const reason = message === "签到功能未启用" ? "disabled" : /^(?:今日|今天)(?:已经|已)?签到(?:过了|，请(?:勿重复签到|明天再来))?$/.test(message) ? "signed" : /^(?:Turnstile 验证失败|请完成人机验证|验证码验证失败)$/.test(message) ? "needs_web" : "failed";
    throw new CheckinBusinessFailure(reason);
  }
  if (root.success !== true) throw new Error("invalid checkin success");
  return object(root.data);
}
export function checkinFailureStatus(context: CheckinContext, state: "disabled" | "unsupported" | "needs_web" | "failed" | "uncertain"): CheckinStatus {
  return checkinStatusSchema.parse({ version: 1, accountId: context.accountId, readAt: context.readAt ?? new Date().toISOString(), month: context.requestedMonth ?? new Date().toISOString().slice(0, 7), monthSource: context.requestedMonth ? "requested" : "client", state, enabled: state === "disabled" ? false : null, checkedInToday: null, minQuota: null, maxQuota: null, records: [], monthCount: null, totalCheckins: null, totalQuota: null, quotaPerUnit: context.quotaPerUnit, unit: context.unit, message: checkinMessages[state] });
}
export function parseCheckinStatus(body: unknown, context: CheckinContext): CheckinStatus {
  if (context.requestedMonth) monthSchema.parse(context.requestedMonth);
  const d = data(body);
  const enabled = z.boolean().parse(d.enabled);
  // Disabled upstream variants may omit their stats completely.
  if (!enabled && d.stats == null) return checkinFailureStatus(context, "disabled");
  const stats = object(d.stats);
  const checked = z.boolean().parse(stats.checked_in_today);
  const rawRecords = z.array(z.object({ checkin_date: dateSchema, quota_awarded: number }).passthrough()).max(31).parse(stats.records ?? []);
  const byDate = new Map<string, number>();
  for (const r of rawRecords) {
    if (byDate.has(r.checkin_date) && byDate.get(r.checkin_date) !== r.quota_awarded) throw new Error("inconsistent checkin dates");
    byDate.set(r.checkin_date, r.quota_awarded);
  }
  const months = new Set([...byDate.keys()].map(v => v.slice(0, 7)));
  if (months.size > 1) throw new Error("inconsistent checkin month");
  const siteMonth = months.values().next().value as string | undefined;
  const month = context.requestedMonth ?? siteMonth ?? new Date().toISOString().slice(0, 7);
  if (siteMonth && siteMonth !== month) throw new Error("wrong checkin month");
  const records = [...byDate].map(([date, quotaAwarded]) => ({ date, quotaAwarded })).sort((a, b) => a.date.localeCompare(b.date));
  const monthCount = stats.checkin_count == null ? records.length : count.parse(stats.checkin_count);
  if (monthCount !== records.length) throw new Error("inconsistent checkin count");
  const totalCheckins = stats.total_checkins == null ? null : count.parse(stats.total_checkins);
  const totalQuota = stats.total_quota == null ? null : number.parse(stats.total_quota);
  if (totalCheckins !== null && totalCheckins < monthCount) throw new Error("inconsistent total count");
  if (totalQuota !== null && totalQuota < records.reduce((n, r) => n + r.quotaAwarded, 0)) throw new Error("inconsistent total quota");
  const minQuota = d.min_quota == null ? null : number.parse(d.min_quota), maxQuota = d.max_quota == null ? null : number.parse(d.max_quota);
  if (minQuota !== null && maxQuota !== null && minQuota > maxQuota) throw new Error("inconsistent quota range");
  const state = !enabled ? "disabled" : checked ? "signed" : "unsigned";
  return checkinStatusSchema.parse({ version: 1, accountId: context.accountId, readAt: context.readAt ?? new Date().toISOString(), month, monthSource: context.requestedMonth ? "requested" : siteMonth ? "site" : "client", state, enabled, checkedInToday: checked, minQuota, maxQuota, records, monthCount, totalCheckins, totalQuota, quotaPerUnit: context.quotaPerUnit, unit: context.unit, message: checkinMessages[state] });
}
export function parseCheckinReward(body: unknown) {
  const d = data(body);
  return recordSchema.parse({ date: d.checkin_date, quotaAwarded: d.quota_awarded });
}
