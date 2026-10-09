import { z } from "zod";
import type { AccountDetails } from "./validation";
import { buildBalanceRequest } from "./adapters";
import { safeJsonRequest } from "./outbound";
import { QueryFailure } from "./query-trace";
import { queryRouteMode, type QueryRouteMode } from "./query-routing";
import {
  aggregateLogs, mergeModelRows, modelDetailSchema, modelHoursSchema,
  modelInsightLimits, modelInsightSchema, modelInsightWarnings as W,
  modelNumber, parseCatalog, parsePerfDetail, parsePerfSummary,
  type ModelDetail, type ModelHours, type ModelInsight, type ModelRow,
} from "./model-insight";

export const modelInsightInput = z.object({ hours: modelHoursSchema, source: z.enum(["auto", "log"]), routeMode: queryRouteMode.optional() }).strict();
export const modelDetailInput = z.object({ hours: modelHoursSchema, source: z.enum(["perf", "log"]), model: z.string().trim().min(1).max(modelInsightLimits.label).refine(v => !/[\u0000-\u001f\u007f]/.test(v)), routeMode: queryRouteMode.optional() }).strict();
export class ModelQueryFailure extends Error {
  constructor(readonly status: 400 | 502, message: string) { super(message); this.name = "ModelQueryFailure"; }
}
type ModelPath = "/api/status" | "/api/pricing" | "/api/perf-metrics/summary" | "/api/perf-metrics" | "/api/log/self";
type Params = { hours?: ModelHours; model?: string; p?: number; page_size?: number; type?: number; start_timestamp?: number; end_timestamp?: number; model_name?: string };
function failure(error: unknown): ModelQueryFailure {
  if (error instanceof ModelQueryFailure) return error;
  if (!(error instanceof QueryFailure)) return new ModelQueryFailure(502, "模型表现响应结构无效；保留上次缓存，请核对站点接口。");
  if (error.httpStatus === 401) return new ModelQueryFailure(502, "管理令牌无效或已过期（HTTP 401）；请核对管理凭据和用户 ID。");
  if (error.httpStatus === 403) return new ModelQueryFailure(502, "站点未授予模型表现读取权限（HTTP 403）；可能关闭了性能模块。");
  if (error.httpStatus === 429) return new ModelQueryFailure(502, "站点请求限流（HTTP 429）；请稍后手动更新。");
  if (error.code === "unsafe_target" || error.code === "invalid_config") return new ModelQueryFailure(502, "只读查询地址或网络访问规则不允许此目标；保留上次缓存。");
  if (error.code === "http_redirect") return new ModelQueryFailure(502, "站点返回重定向；已拒绝跟随，请核对最终管理接口地址。");
  if (error.httpStatus === 404) return new ModelQueryFailure(502, "站点没有所需只读接口（HTTP 404）；保留上次缓存。");
  if (error.code.includes("timeout")) return new ModelQueryFailure(502, "模型表现读取超时；已耗尽本次总时限，请稍后手动更新。");
  return new ModelQueryFailure(502, "模型表现读取失败；保留上次缓存，请检查站点服务和部署线路。");
}
function reader(account: AccountDetails, credential: string | null | undefined, routeMode: QueryRouteMode) {
  if (account.provider !== "newapi") throw new ModelQueryFailure(400, "模型表现首轮仅支持 New API 账户管理模板。");
  if (account.archived) throw new ModelQueryFailure(400, "归档账号不能读取模型表现。");
  // Use the balance adapter's exact prefix normalization, but never its path
  // mapping. Every external path is an internal static allowlist member.
  let base: URL;
  try { base = new URL(buildBalanceRequest(account).url); }
  catch { throw new ModelQueryFailure(400, "管理接口根地址无效。"); }
  const prefix = base.pathname.replace(/\/api\/user\/self$/, "");
  const deadline = performance.now() + account.query.timeoutSeconds * 1000;
  const readAt = new Date().toISOString(), end = Math.floor(Date.parse(readAt) / 1000);
  const read = async (path: ModelPath, params: Params = {}, publicEndpoint = true) => {
    const url = new URL(base);
    url.pathname = prefix + path; url.search = ""; url.hash = "";
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const request = (anonymous: boolean) => safeJsonRequest(url.toString(), anonymous ? "" : credential || "", anonymous ? "" : account.userId, { timeoutSeconds: account.query.timeoutSeconds, routeMode, requestProfile: account.query.requestProfile || "atlas", authMode: anonymous ? "anonymous" : "credential", deadline });
    if (!publicEndpoint) {
      if (!credential) throw new ModelQueryFailure(400, "读取个人调用记录需要账户管理凭据。");
      return request(false);
    }
    try { return await request(true); }
    catch (error) {
      if (error instanceof QueryFailure && error.httpStatus === 401 && credential) return request(false);
      throw error;
    }
  };
  return { read, readAt, end, deadline };
}
type Reader = ReturnType<typeof reader>;
function responseData(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid log response");
  const root = body as Record<string, unknown>;
  if (root.success === false || root.error != null || !root.data || typeof root.data !== "object") throw new Error("invalid log response");
  if (Array.isArray(root.data)) return { items: root.data };
  return root.data as Record<string, unknown>;
}
async function logs(r: Reader, hours: ModelHours, model?: string) {
  const start = r.end - hours * 3600, items: unknown[] = [];
  let truncated = false, incomplete = false;
  const seenIds = new Set<string>(), fingerprints = new Set<string>();
  for (let page = 1; page <= modelInsightLimits.logPages; page++) {
    let data: Record<string, unknown>;
    try { data = responseData(await r.read("/api/log/self", { p: page, page_size: modelInsightLimits.logPageSize, type: 0, start_timestamp: start, end_timestamp: r.end, ...(model ? { model_name: model } : {}) }, false)); }
    catch (error) { if (!items.length) throw error; truncated = true; incomplete = true; break; }
    if (!Array.isArray(data.items)) { if (!items.length) throw new Error("invalid log page"); truncated = true; incomplete = true; break; }
    const returnedPage = modelNumber(data.page), pageSize = modelNumber(data.page_size);
    const invalidPage = data.page !== undefined && (returnedPage === null || !Number.isSafeInteger(returnedPage) || returnedPage !== page);
    const invalidSize = data.page_size !== undefined && (pageSize === null || !Number.isSafeInteger(pageSize) || pageSize !== modelInsightLimits.logPageSize);
    if (invalidPage || invalidSize) { if (!items.length) throw new Error("invalid log pagination"); truncated = true; incomplete = true; break; }
    const batch = data.items.slice(0, modelInsightLimits.logPageSize);
    const total = modelNumber(data.total);
    const observed = (page - 1) * modelInsightLimits.logPageSize + batch.length;
    if (data.total !== undefined && (total === null || !Number.isSafeInteger(total) || total < observed)) {
      if (!items.length) throw new Error("invalid log total");
      truncated = true; incomplete = true; break;
    }
    truncated ||= data.items.length > modelInsightLimits.logPageSize;
    const fingerprint = JSON.stringify(batch);
    if (batch.length && fingerprints.has(fingerprint)) { truncated = true; incomplete = true; break; }
    fingerprints.add(fingerprint);
    for (const item of batch) {
      const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const id = typeof row.id === "number" || typeof row.id === "string" ? String(row.id) : null;
      if (id !== null && seenIds.has(id)) { truncated = true; continue; }
      if (id !== null) seenIds.add(id);
      items.push(item);
    }
    if (page === modelInsightLimits.logPages && batch.length === modelInsightLimits.logPageSize) truncated = true;
    if (batch.length < modelInsightLimits.logPageSize) { if (total !== null && total > (page - 1) * modelInsightLimits.logPageSize + batch.length) { truncated = true; incomplete = true; } break; }
    if (total !== null && total <= page * modelInsightLimits.logPageSize) break;
  }
  const aggregated = aggregateLogs(items, start, r.end, model);
  return { ...aggregated, truncated: truncated || aggregated.truncated || incomplete, windowStart: new Date(start * 1000).toISOString(), windowEnd: new Date(r.end * 1000).toISOString() };
}
// Provider echoes must not disclose the actual credential through even an
// allowlisted label. We discard affected rows/groups, never rewrite labels.
function safeRows(rows: ModelRow[], credential: string | null | undefined) {
  return credential ? rows.filter(row => ![row.model, row.vendor, ...row.groups].some(v => v.includes(credential))) : rows;
}
export async function queryModelInsight(account: AccountDetails, credential: string | null | undefined, accountId: string, input: z.infer<typeof modelInsightInput>, routeMode: QueryRouteMode): Promise<ModelInsight> {
  try {
    const r = reader(account, credential, routeMode), warnings: string[] = [];
    // Public metadata may be absent on older branches. All reads retain the
    // same operation deadline and no endpoint can trigger a model invocation.
    try { await r.read("/api/status"); } catch (error) { if (error instanceof QueryFailure && (error.code === "unsafe_target" || error.code === "invalid_config" || error.code.includes("timeout"))) throw error; warnings.push(W.status); }
    let catalog: ReturnType<typeof parseCatalog> = { rows: [], truncated: false }, catalogAvailable = false;
    try { catalog = parseCatalog(await r.read("/api/pricing")); catalogAvailable = true; } catch (error) { if (error instanceof QueryFailure && (error.code === "unsafe_target" || error.code === "invalid_config" || error.code.includes("timeout"))) throw error; warnings.push(W.catalog); }
    let source: ModelInsight["source"] = "perf", values: { rows: ModelRow[]; truncated: boolean; windowStart: string | null; windowEnd: string | null };
    if (input.source === "log") { source = "log"; values = await logs(r, input.hours); warnings.push(W.estimate); }
    else {
      try { values = parsePerfSummary(await r.read("/api/perf-metrics/summary", { hours: input.hours })); }
      catch (error) {
        if (!(error instanceof QueryFailure) || error.httpStatus !== 404) throw error;
        warnings.push(W.fallback);
        try { source = "log"; values = await logs(r, input.hours); warnings.push(W.estimate); }
        catch (logError) {
          // Catalog-only is useful for unsupported sites; any existing good
          // metric cache is retained by the API instead of being overwritten.
          if (!catalogAvailable || (logError instanceof QueryFailure && (logError.code === "unsafe_target" || logError.code.includes("timeout")))) throw logError;
          source = "catalog"; values = { rows: [], truncated: false, windowStart: null, windowEnd: null };
          warnings.push(logError instanceof QueryFailure && (logError.httpStatus === 401 || logError.httpStatus === 403) ? W.permission : W.logsUnavailable);
        }
      }
    }
    const rows = safeRows(mergeModelRows(catalog.rows, values.rows), credential);
    const truncated = catalog.truncated || values.truncated || new Set([...catalog.rows, ...values.rows].map(row => row.model)).size > modelInsightLimits.rows;
    if (truncated) warnings.push(W.incomplete);
    if (!values.rows.length) warnings.push(W.noMetrics);
    if (rows.some(row => row.trend.some(point => point.at === null))) warnings.push(W.legacyTime);
    return modelInsightSchema.parse({ version: 1, accountId, readAt: r.readAt, hours: input.hours, source, windowStart: values.windowStart, windowEnd: values.windowEnd, rows, truncated, catalogAvailable, warnings: [...new Set(warnings)] });
  } catch (error) { throw failure(error); }
}
export async function queryModelDetail(account: AccountDetails, credential: string | null | undefined, accountId: string, input: z.infer<typeof modelDetailInput>, routeMode: QueryRouteMode): Promise<ModelDetail> {
  try {
    const r = reader(account, credential, routeMode), warnings: string[] = [];
    let source = input.source;
    let values: { groups: ModelDetail["groups"]; truncated: boolean; windowStart: string | null; windowEnd: string | null };
    const readLogs = async () => {
      const result = await logs(r, input.hours, input.model), row = safeRows(result.rows, credential)[0];
      return { groups: row ? [{ group: "我的调用记录", successRate: row.successRate, avgLatencyMs: row.avgLatencyMs, avgTtftMs: row.avgTtftMs, avgTps: row.avgTps, sampleCount: row.sampleCount, series: row.trend }] : [], truncated: result.truncated, windowStart: result.windowStart, windowEnd: result.windowEnd };
    };
    if (source === "log") { values = await readLogs(); warnings.push(W.estimate); }
    else {
      try { values = parsePerfDetail(await r.read("/api/perf-metrics", { model: input.model, hours: input.hours }), input.model); }
      catch (error) { if (!(error instanceof QueryFailure) || error.httpStatus !== 404) throw error; source = "log"; values = await readLogs(); warnings.push(W.fallback, W.estimate); }
    }
    if (credential) values.groups = values.groups.filter(group => !group.group.includes(credential));
    if (values.truncated) warnings.push(W.incomplete);
    if (!values.groups.length) warnings.push(W.noMetrics);
    return modelDetailSchema.parse({ version: 1, accountId, model: input.model, hours: input.hours, source, readAt: r.readAt, ...values, warnings });
  } catch (error) { throw failure(error); }
}
