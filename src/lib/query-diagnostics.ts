import { z } from "zod";
import { queryRouteMode } from "./query-routing";

export const stageIds = [
  "dns",
  "connect",
  "response",
  "read",
  "parse",
] as const;
export type QueryStageId = (typeof stageIds)[number];
export const stageLabels: Record<QueryStageId, string> = {
  dns: "DNS 解析",
  connect: "建立连接",
  response: "等待响应",
  read: "读取响应",
  parse: "余额解析",
};
export const codeCategories = {
  ok: "success",
  dns_failed: "network",
  dns_timeout: "network",
  proxy_config: "configuration",
  proxy_auth: "auth",
  proxy_failed: "network",
  proxy_timeout: "network",
  connect_failed: "network",
  connect_timeout: "network",
  tls_error: "network",
  response_timeout: "network",
  response_failed: "network",
  response_empty: "service",
  read_failed: "network",
  read_timeout: "network",
  http_auth: "auth",
  http_missing: "compatibility",
  http_redirect: "compatibility",
  http_limited: "rate-limit",
  http_error: "service",
  provider_rejected: "service",
  invalid_json: "compatibility",
  response_html: "compatibility",
  response_challenge: "service",
  response_encoding: "compatibility",
  response_text_encoding: "compatibility",
  response_too_large: "compatibility",
  invalid_balance: "compatibility",
  unsafe_target: "security",
  invalid_config: "configuration",
  missing_credential: "configuration",
  query_failed: "service",
} as const;
export type QueryCode = keyof typeof codeCategories;
const codes = Object.keys(codeCategories) as [QueryCode, ...QueryCode[]];
const ms = z.number().finite().min(0).max(3600000);
export const responseInfoSchema = z.object({
  mediaType: z.enum(["json", "html", "text", "other", "missing"]),
  encoding: z.enum(["identity", "gzip", "deflate", "br", "unsupported"]),
  bodyKind: z.enum([
    "unknown",
    "json",
    "html",
    "challenge",
    "empty",
    "non-json",
  ]),
  wireBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  decodedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type QueryResponseInfo = z.infer<typeof responseInfoSchema>;
const diagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.enum([
      "manual",
      "newapi",
      "newapi-token",
      "generic",
      "deepseek",
      "openrouter",
      "siliconflow",
      "custom",
    ]),
    operation: z.enum(["test", "sync"]),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    totalMs: ms,
    timeoutSeconds: z.union([z.literal(10), z.literal(20), z.literal(30)]),
    dnsMode: z.enum(["system", "cloudflare"]),
    // Older reports intentionally retain an unknown route instead of inventing one.
    routeMode: queryRouteMode.optional(),
    requestProfile: z.enum(["atlas", "cc-switch"]).optional(),
    response: responseInfoSchema.optional(),
    outcome: z.enum(["success", "failure"]),
    category: z.enum([
      "success",
      "network",
      "auth",
      "compatibility",
      "rate-limit",
      "service",
      "security",
      "configuration",
    ]),
    code: z.enum(codes),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    stages: z
      .array(
        z.object({
          id: z.enum(stageIds),
          status: z.enum(["success", "error", "skipped", "not-run"]),
          durationMs: ms.nullable(),
        }),
      )
      .length(stageIds.length),
  })
  .superRefine((d, ctx) => {
    if (
      codeCategories[d.code] !== d.category ||
      (d.code === "ok") !== (d.outcome === "success")
    )
      ctx.addIssue({ code: "custom", message: "诊断结果不一致" });
    if (
      d.stages.some(
        (s, i) =>
          s.id !== stageIds[i] ||
          (s.status === "not-run") !== (s.durationMs === null) ||
          (s.status === "skipped" && s.durationMs !== 0),
      )
    )
      ctx.addIssue({ code: "custom", message: "诊断阶段不正确" });
  });
export type QueryDiagnostic = z.infer<typeof diagnosticSchema>;
export type QueryConfig = Pick<
  QueryDiagnostic,
  | "provider"
  | "operation"
  | "timeoutSeconds"
  | "dnsMode"
  | "routeMode"
  | "requestProfile"
>;

// Zod object parsing strips unknown properties at every level. Never serialize
// the caller's object or an upstream error, even for already typed values.
export function normalizeDiagnostic(input: unknown): QueryDiagnostic | null {
  const parsed = diagnosticSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
export function diagnosticReport(input: unknown): string {
  const d = normalizeDiagnostic(input);
  if (!d) throw new Error("诊断信息无效，请重新点击测试连接");
  return JSON.stringify(d, null, 2);
}
export function diagnosticExplanation(d: QueryDiagnostic) {
  const titles: Record<QueryDiagnostic["category"], string> = {
    success: "查询链路正常",
    network: "网络连接问题",
    auth: "令牌或权限问题",
    compatibility: "接口或响应不兼容",
    "rate-limit": "站点请求限流",
    service: "站点拒绝或服务异常",
    security: "请求被安全规则拦截",
    configuration: "查询配置未完成",
  };
  const hints: Record<QueryCode, string> = {
    ok:
      d.operation === "test"
        ? "已读取并解析余额，测试没有修改余额或新增快照。"
        : "本次余额已写入真实历史快照。",
    dns_failed:
      "先检查部署服务器的 DNS 和域名可达性。不会自动切换 DNS 或启用代理。",
    dns_timeout: "DNS 解析已耗尽查询时间。先排查部署 DNS，而不是只延长超时。",
    proxy_config:
      "所选代理线路需要部署端配置有效的查询代理。可手动切换直连；不会自动回退。只支持 HTTP/HTTPS CONNECT 和可选 Basic 认证，不接受路径、查询参数、SOCKS 或禁止网络地址。",
    proxy_auth:
      "查询代理返回 HTTP 407。检查部署代理的 Basic 凭据，不要修改站点令牌；两类认证分别发送。不会重试或回退直连。",
    proxy_failed:
      "检查部署代理的 DNS、端口、TLS 证书与 HTTP CONNECT 支持（包含目标端口策略）。不会跳过证书校验、跟随代理重定向或回退直连。",
    proxy_timeout:
      "查询代理 DNS、连接或 CONNECT 隧道未在查询总时限内完成。检查部署代理与网络；DNS、代理和目标请求共享同一时限，无自动重试。",
    connect_failed:
      "检查部署服务器到站点的端口、直连网络和防火墙。浏览器可访问不代表服务器可直连。",
    connect_timeout:
      "建立连接未完成（HTTPS 包含 TLS）。先检查网络、端口和站点防火墙；没有自动重试。",
    tls_error: "检查站点 TLS 证书和部署时间；不会跳过证书验证。",
    response_timeout:
      "已建立连接，但没有及时收到响应头。检查站点状态、查询根地址和部署网络；不会自动重试。",
    response_failed:
      "已建立连接，但在收到响应头前连接中断。检查部署链路和站点服务，再手动查询。",
    read_failed: "站点在读取响应时断开连接。检查站点服务和网络，再手动查询。",
    read_timeout:
      "已收到响应头，但正文没有按时完成。检查站点服务和网络，余额没有清零。",
    http_auth:
      "HTTP 401/403 可能是密钥、查询权限或站点防护拒绝。核对所选查询口径：账户管理令牌、用户 ID 或 Management Key。",
    http_missing:
      "核对平台模板与最终管理接口根地址；站点可能未开放此余额接口。不要只填聊天接口 /v1。",
    http_redirect:
      "为防止凭据跨站传递，没有跟随重定向。请填写最终管理接口根地址。",
    http_limited: "站点返回 HTTP 429。稍后手动重试，不会自动重试或轮询。",
    http_error:
      "站点返回异常 HTTP 状态。检查站点服务与接口地址，未覆盖上次余额。",
    provider_rejected:
      "站点在响应中拒绝了查询；不能仅据此判断令牌无效。检查账户/令牌查询口径、用户 ID 与站点控制台。",
    response_empty:
      "HTTP 200 的正文为空或只有空白字符，余额字段解析尚未开始。检查站点服务及网络出口，并核对部署端查询代理是否配置和生效；不能据此断定令牌无效或接口字段不兼容。",
    invalid_json:
      "响应解码后仍不是合法 JSON，余额字段提取尚未开始。对照 CC Switch 的完整接口路径、请求特征和查询线路；不能仅凭此错误归因于 New API 版本。",
    response_html:
      "收到的是 HTML 网页，不是余额 JSON。可能是登录页、首页兜底或网关页面；先对照实际接口和线路，而不是修改余额字段。",
    response_challenge:
      "响应包含疑似防护验证页特征，尚未提取余额。对照 CC Switch 的请求特征和网络出口；不会执行验证码、携带浏览器 Cookie 或自动绕过验证。",
    response_encoding:
      "响应压缩格式不支持或压缩流损坏。已支持 gzip、deflate、Brotli；请检查网关的 Content-Encoding 或尝试相同查询线路。",
    response_text_encoding:
      "解压后的正文不是有效 UTF-8 文本，尚未进入余额解析。请检查站点或网关响应编码。",
    response_too_large:
      "压缩输入或解压输出超过 1 MB 限制。为防止过大响应与压缩炸弹已终止读取；请检查接口地址。",
    invalid_balance:
      "JSON 已读取，但不能按当前模板确认余额。检查字段、币种、账户/令牌口径及换算系数；没有猜测余额。",
    unsafe_target:
      "域名解析或地址不符合外部请求限制。仅普通私有站点可通过部署允许列表显式配置，云元数据始终禁止。",
    invalid_config:
      "核对平台、查询根地址、超时和部署 DNS 配置。报告不包含凭据或具体地址。",
    missing_credential:
      "在查询配置中填写此平台所需的密钥或管理令牌后，手动测试连接。",
    query_failed:
      "本次查询没有完成。核对本机服务与查询配置，再手动测试；不会输出底层原始错误。",
  };
  const proxyTitles: Partial<Record<QueryCode, string>> = {
    response_empty: "站点返回空响应",
    proxy_config: "查询代理配置不正确",
    proxy_auth: "查询代理认证失败",
    proxy_failed: "查询代理连接失败",
    proxy_timeout: "查询代理超时",
    response_html: "站点返回网页",
    response_challenge: "收到疑似防护验证页",
    response_encoding: "响应压缩解码失败",
    response_text_encoding: "响应文本编码不兼容",
  };
  return {
    title: proxyTitles[d.code] || titles[d.category],
    hint: hints[d.code],
  };
}

// Public text must not trust even a typed error's arbitrary message.
export function publicQueryError(d: QueryDiagnostic): string {
  const messages: Record<QueryCode, string> = {
    ok: "查询已完成",
    dns_failed: "DNS 解析失败，请检查部署服务器 DNS",
    dns_timeout: "查询超时（DNS 解析），请先检查部署服务器 DNS",
    proxy_config:
      "查询代理配置不正确，请检查部署代理设置（仅支持 HTTP/HTTPS CONNECT）",
    proxy_auth: "查询代理认证失败（HTTP 407），请检查部署代理凭据而非站点令牌",
    proxy_failed:
      "查询代理连接或 CONNECT 隧道建立失败，请检查部署代理 DNS、TLS 与网络",
    proxy_timeout: "查询代理超时，代理与目标共享查询总时限，上次余额仍保留",
    connect_failed: "无法连接站点，请检查部署网络与端口",
    response_failed: "连接在等待响应时中断，请检查站点与网络",
    response_empty:
      "站点返回空响应（HTTP 200），请检查站点服务与网络出口，上次余额仍保留",
    tls_error: "站点 TLS 证书验证失败，不会跳过验证",
    connect_timeout: "查询超时（建立连接），请检查网络、端口与 TLS",
    response_timeout: "查询超时（等待响应），上次余额仍保留",
    read_timeout: "查询超时（读取响应），上次余额仍保留",
    read_failed: "站点响应中断，上次余额仍保留",
    http_auth: "令牌、查询权限或站点防护拒绝（HTTP 401/403），请核对查询口径",
    http_missing: "余额接口不存在（HTTP 404），请核对平台与最终管理接口根地址",
    http_redirect: "站点返回重定向，已拒绝跟随，请填写最终接口地址",
    http_limited: "站点请求限流（HTTP 429），请稍后手动重试",
    http_error: "站点返回异常 HTTP 状态，详见查询诊断",
    provider_rejected: "站点在响应中拒绝查询，请核对账户、用户 ID 与查询模板",
    invalid_json: "站点返回的内容不是有效 JSON，请检查接口地址",
    response_html: "站点返回 HTML 网页而非余额 JSON，请对照接口地址与查询线路",
    response_challenge: "收到疑似站点防护验证页，请对照请求特征与网络出口",
    response_encoding: "响应压缩格式不支持或数据损坏，请检查网关编码与查询线路",
    response_text_encoding: "响应文本不是有效 UTF-8，请检查站点或网关编码",
    response_too_large: "站点压缩输入或解压输出超过 1 MB 限制，请检查接口地址",
    invalid_balance:
      "接口余额不能按当前查询模板解析，请检查字段、单位和查询口径",
    unsafe_target: "目标为私有或禁止访问的网络，请检查部署允许列表",
    invalid_config: "查询配置不正确，请检查凭据字符、接口地址和部署 DNS 设置",
    missing_credential: "请先在查询配置中填写此平台所需的密钥或管理令牌",
    query_failed: "查询未完成，请检查本机服务与查询配置",
  };
  return messages[d.code] || "查询未完成，请检查查询诊断";
}
