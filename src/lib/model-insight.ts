import { z } from "zod";

// This module is intentionally client-safe: only aggregate values cross the
// boundary. Raw provider bodies and log records never belong to the contract.
export const modelInsightLimits = { rows: 500, groups: 32, points: 168, logPages: 6, logPageSize: 100, label: 200 } as const;
export const modelInsightWarnings = {
  catalog: "模型目录不可用；目录不代表账号拥有调用权限。",
  status: "站点能力信息不可用；已按固定只读接口读取。",
  fallback: "站点性能接口不存在；改为汇总我的调用记录，不代表站点全局表现。",
  estimate: "日志输出速度为估算值，口径与站点 TPS 不同。",
  incomplete: "数据读取不完整或达到采样上限；指标仅代表已读取的样本。",
  noMetrics: "当前窗口没有可用的表现数据；缺失指标保留为空。",
  logsUnavailable: "个人调用记录不可用；仅显示模型目录。",
  permission: "个人调用记录读取权限不足；仅显示模型目录。",
  legacyTime: "旧版趋势没有时间戳；无法确定各采样点的时间。",
} as const;
const labelSchema = z.string().min(1).max(modelInsightLimits.label).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
const numeric = (max = Number.MAX_SAFE_INTEGER) => z.number().finite().min(0).max(max).nullable();
const iso = z.iso.datetime().nullable();
const metricsShape = { successRate: numeric(100), avgLatencyMs: numeric(), avgTtftMs: numeric(), avgTps: numeric(), sampleCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() };
const pointSchema = z.object({ at: iso, successRate: numeric(100), avgLatencyMs: numeric(), avgTtftMs: numeric(), avgTps: numeric() }).strict();
const rowSchema = z.object({ model: labelSchema, vendor: z.union([labelSchema, z.literal("")]), groups: z.array(labelSchema).max(modelInsightLimits.groups), inCatalog: z.boolean(), ...metricsShape, trend: z.array(pointSchema).max(modelInsightLimits.points) }).strict();
export const modelHoursSchema = z.union([z.literal(24), z.literal(72), z.literal(168)]);
const baseShape = { version: z.literal(1), accountId: z.string().min(1).max(100), readAt: z.iso.datetime(), hours: modelHoursSchema, windowStart: iso, windowEnd: iso, truncated: z.boolean(), warnings: z.array(z.enum(Object.values(modelInsightWarnings) as [string, ...string[]])).max(12) };
const orderedWindow = (v: { windowStart: string | null; windowEnd: string | null }) => !v.windowStart || !v.windowEnd || Date.parse(v.windowStart) <= Date.parse(v.windowEnd);
export const modelInsightSchema = z.object({ ...baseShape, source: z.enum(["perf", "log", "catalog"]), rows: z.array(rowSchema).max(modelInsightLimits.rows), catalogAvailable: z.boolean() }).strict().refine(orderedWindow);
export const modelDetailSchema = z.object({ ...baseShape, model: labelSchema, source: z.enum(["perf", "log"]), groups: z.array(z.object({ group: labelSchema, ...metricsShape, series: z.array(pointSchema).max(modelInsightLimits.points) }).strict()).max(modelInsightLimits.groups) }).strict().refine(orderedWindow);
export type ModelInsight = z.infer<typeof modelInsightSchema>;
export type ModelRow = z.infer<typeof rowSchema>;
export type ModelPoint = z.infer<typeof pointSchema>;
export type ModelDetail = z.infer<typeof modelDetailSchema>;
export type ModelHours = z.infer<typeof modelHoursSchema>;

export function normalizeModelInsight(value: unknown, accountId: string): ModelInsight | null {
  const parsed = modelInsightSchema.safeParse(value);
  return parsed.success && parsed.data.accountId === accountId ? parsed.data : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function payload(value: unknown): Record<string, unknown> {
  const root = record(value);
  if (root.success === false || root.error != null) throw new Error("invalid model response");
  return root;
}
function label(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  return labelSchema.safeParse(cleaned).success ? cleaned : "";
}
export function modelNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}
export function modelTimestamp(value: unknown): string | null {
  const n = modelNumber(value, 253402300799);
  if (n !== null && n > 0) return new Date(n * 1000).toISOString();
  if (typeof value === "string" && z.iso.datetime().safeParse(value).success) return value;
  return null;
}
function metrics(value: unknown) {
  const e = record(value), count = modelNumber(e.sample_count ?? e.request_count ?? e.total_count);
  return { successRate: modelNumber(e.success_rate, 100), avgLatencyMs: modelNumber(e.avg_latency_ms), avgTtftMs: modelNumber(e.avg_ttft_ms), avgTps: modelNumber(e.avg_tps), sampleCount: count !== null && Number.isSafeInteger(count) ? count : null };
}
const emptyMetrics = () => metrics({});
function series(value: unknown): ModelPoint[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-modelInsightLimits.points).map(v => {
    const e = record(v);
    const m = metrics(e);
    return { at: modelTimestamp(e.ts ?? e.timestamp ?? e.at), successRate: m.successRate, avgLatencyMs: m.avgLatencyMs, avgTtftMs: m.avgTtftMs, avgTps: m.avgTps };
  });
}
function trend(value: Record<string, unknown>): ModelPoint[] {
  if (Array.isArray(value.recent_success_series)) return series(value.recent_success_series);
  if (Array.isArray(value.recent_success_rates)) return value.recent_success_rates.slice(-modelInsightLimits.points).map(v => ({ at: null, successRate: modelNumber(v, 100), avgLatencyMs: null, avgTtftMs: null, avgTps: null }));
  return series(value.series);
}
export function parseCatalog(body: unknown) {
  const root = payload(body);
  if (!Array.isArray(root.data)) throw new Error("invalid catalog response");
  const rows: ModelRow[] = [], seen = new Set<string>();
  let truncated = root.data.length > modelInsightLimits.rows;
  for (const raw of root.data.slice(0, modelInsightLimits.rows)) {
    const e = record(raw), model = label(e.model_name);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const groups = Array.isArray(e.enable_groups) ? e.enable_groups : [];
    truncated ||= groups.length > modelInsightLimits.groups;
    rows.push({ model, vendor: label(e.owner_by), groups: [...new Set(groups.slice(0, modelInsightLimits.groups).map(label).filter(Boolean))], inCatalog: true, ...emptyMetrics(), trend: [] });
  }
  return { rows, truncated };
}
export function parsePerfSummary(body: unknown) {
  const data = record(payload(body).data);
  if (!Array.isArray(data.models)) throw new Error("invalid perf response");
  const rows: ModelRow[] = [], seen = new Set<string>();
  let truncated = data.models.length > modelInsightLimits.rows;
  for (const raw of data.models.slice(0, modelInsightLimits.rows)) {
    const e = record(raw), model = label(e.model_name);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    for (const key of ["recent_success_series", "recent_success_rates", "series"]) truncated ||= Array.isArray(e[key]) && e[key].length > modelInsightLimits.points;
    rows.push({ model, vendor: "", groups: [], inCatalog: false, ...metrics(e), trend: trend(e) });
  }
  return { rows, truncated, windowStart: modelTimestamp(data.start_timestamp ?? data.window_start), windowEnd: modelTimestamp(data.end_timestamp ?? data.window_end) };
}
export function parsePerfDetail(body: unknown, model: string) {
  const data = record(payload(body).data);
  if (!Array.isArray(data.groups) || (label(data.model_name) && data.model_name !== model)) throw new Error("invalid detail response");
  let truncated = data.groups.length > modelInsightLimits.groups;
  const groups: ModelDetail["groups"] = [];
  for (const raw of data.groups.slice(0, modelInsightLimits.groups)) {
    const e = record(raw), group = label(e.group) || "默认分组";
    truncated ||= Array.isArray(e.series) && e.series.length > modelInsightLimits.points;
    groups.push({ group, ...metrics(e), series: series(e.series) });
  }
  return { groups, truncated, windowStart: modelTimestamp(data.start_timestamp ?? data.window_start), windowEnd: modelTimestamp(data.end_timestamp ?? data.window_end) };
}
export function mergeModelRows(catalog: ModelRow[], metricsRows: ModelRow[]): ModelRow[] {
  const byModel = new Map(metricsRows.map(r => [r.model, r]));
  const rows = catalog.map(r => byModel.has(r.model) ? { ...byModel.get(r.model)!, vendor: r.vendor, groups: r.groups, inCatalog: true } : r);
  const seen = new Set(rows.map(r => r.model));
  for (const r of metricsRows) if (!seen.has(r.model)) { rows.push(r); seen.add(r.model); }
  return rows.slice(0, modelInsightLimits.rows);
}
type Acc = { count: number; failed: number; latency: number; latencyN: number; ttft: number; ttftN: number; tokens: number; seconds: number };
const accumulator = (): Acc => ({ count: 0, failed: 0, latency: 0, latencyN: 0, ttft: 0, ttftN: 0, tokens: 0, seconds: 0 });
function accumulate(a: Acc, e: Record<string, unknown>) {
  a.count++; if (Number(e.type) === 5) a.failed++;
  const seconds = modelNumber(e.use_time, 86400), tokens = modelNumber(e.completion_tokens, 1e9);
  if (seconds !== null && seconds > 0) { a.latency += seconds * 1000; a.latencyN++; }
  let other: unknown = e.other;
  if (typeof other === "string" && other.length <= 16384) { try { other = JSON.parse(other); } catch { other = null; } }
  const ttft = modelNumber(record(other).frt, 86400000);
  if (ttft !== null) { a.ttft += ttft; a.ttftN++; }
  if (Number(e.type) === 2 && tokens !== null && seconds !== null && seconds > 0) { a.tokens += tokens; a.seconds += seconds; }
}
function finish(a: Acc) {
  return { successRate: a.count ? (a.count - a.failed) / a.count * 100 : null, avgLatencyMs: a.latencyN ? a.latency / a.latencyN : null, avgTtftMs: a.ttftN ? a.ttft / a.ttftN : null, avgTps: a.seconds > 0 ? a.tokens / a.seconds : null, sampleCount: a.count || null };
}
export function aggregateLogs(items: unknown[], start: number, end: number, model?: string) {
  const models = new Map<string, { acc: Acc; buckets: Map<number, Acc>; groups: Set<string> }>();
  let truncated = items.length > modelInsightLimits.logPages * modelInsightLimits.logPageSize;
  for (const raw of items.slice(0, modelInsightLimits.logPages * modelInsightLimits.logPageSize)) {
    const e = record(raw), name = label(e.model_name), type = modelNumber(e.type), at = modelNumber(e.created_at, 253402300799);
    if (!name || (model && name !== model) || (type !== 2 && type !== 5) || at === null || at < start || at > end) continue;
    let row = models.get(name);
    if (!row) { if (models.size >= modelInsightLimits.rows) { truncated = true; continue; } row = { acc: accumulator(), buckets: new Map(), groups: new Set() }; models.set(name, row); }
    accumulate(row.acc, e);
    const group = label(e.group);
    if (group && !row.groups.has(group)) {
      if (row.groups.size < modelInsightLimits.groups) row.groups.add(group);
      else truncated = true;
    }
    const bucket = Math.floor(at / 3600) * 3600;
    const acc = row.buckets.get(bucket) || accumulator(); accumulate(acc, e); row.buckets.set(bucket, acc);
  }
  const rows: ModelRow[] = [...models.entries()].map(([name, row]) => {
    const buckets = [...row.buckets.entries()].sort((a, b) => a[0] - b[0]);
    truncated ||= buckets.length > modelInsightLimits.points;
    return { model: name, vendor: "", groups: [...row.groups], inCatalog: false, ...finish(row.acc), trend: buckets.slice(-modelInsightLimits.points).map(([ts, acc]) => { const m = finish(acc); return { at: modelTimestamp(ts), successRate: m.successRate, avgLatencyMs: m.avgLatencyMs, avgTtftMs: m.avgTtftMs, avgTps: m.avgTps }; }) };
  });
  return { rows, truncated };
}
export function filterModelRows(rows: ModelRow[], options: { search: string; trafficOnly: boolean; sort: "model" | "successRate" | "avgLatencyMs" | "avgTtftMs" | "avgTps" | "sampleCount" }) {
  const search = options.search.trim().toLocaleLowerCase();
  return rows.filter(r => (!search || r.model.toLocaleLowerCase().includes(search) || r.vendor.toLocaleLowerCase().includes(search)) && (!options.trafficOnly || (r.sampleCount !== null && r.sampleCount > 0) || r.successRate !== null || r.avgLatencyMs !== null || r.avgTps !== null || r.avgTtftMs !== null || r.trend.length > 0)).sort((a, b) => {
    if (options.sort === "model") return a.model.localeCompare(b.model);
    const x = a[options.sort], y = b[options.sort];
    if (x === null) return y === null ? a.model.localeCompare(b.model) : 1;
    if (y === null) return -1;
    const direction = options.sort === "avgLatencyMs" || options.sort === "avgTtftMs" ? 1 : -1;
    return (x - y) * direction || a.model.localeCompare(b.model);
  });
}
