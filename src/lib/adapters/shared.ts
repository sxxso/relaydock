import Decimal from "decimal.js";
import { amount } from "../money";
import { querySchema, type AccountDetails } from "../validation";
import { QueryFailure } from "../query-trace";
import type { BalanceRequest, BalanceResult, PlatformMetadata } from "./types";
export function buildRequest(
  account: AccountDetails,
  metadata: PlatformMetadata,
): BalanceRequest {
  const q = querySchema.parse(account.query || {});
  const url = new URL(
    account.managementUrl || account.apiUrl || metadata.root || account.siteUrl,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("无效查询地址");
  let prefix = url.pathname.replace(/\/+$/, "");
  if (!metadata.capabilities.customMapping)
    prefix = prefix.replace(
      /\/(?:api\/user\/self|api\/usage\/token|api\/v1\/credits|v1\/user\/info|user\/balance|api\/v1|v1|api)$/,
      "",
    );
  url.pathname = prefix + (metadata.endpoint || q.path);
  url.search = "";
  url.hash = "";
  return {
    url: url.toString(),
    ...(q.requestProfile ? { requestProfile: q.requestProfile } : {}),
    timeoutSeconds: q.timeoutSeconds,
    authHeader: metadata.capabilities.customMapping
      ? q.authHeader
      : "Authorization",
    userId: metadata.capabilities.userId === "optional" ? account.userId : "",
  };
}
export function responseBody(
  body: unknown,
  account: AccountDetails,
  checkValidity = true,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("站点返回的余额结构无效");
  querySchema.parse(account.query || {});
  const b = body as Record<string, unknown>;
  if (
    b.success === false ||
    b.status === false ||
    b.error != null ||
    (checkValidity && b.isValid === false)
  )
    throw new QueryFailure(
      "provider_rejected",
      "站点拒绝余额查询，请检查凭据权限、用户 ID 与查询模板",
    );
  return b;
}
export function readPath(body: unknown, path: string): unknown {
  let value = body;
  for (const key of path.split(".")) {
    if (
      !value ||
      typeof value !== "object" ||
      !Object.prototype.hasOwnProperty.call(value, key)
    )
      throw new Error("站点响应缺少配置的余额字段，请核对查询模板与字段路径");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function decimalValue(value: unknown): Decimal {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      throw new Error("余额超出安全数值范围，请使用字符串金额接口");
    value = new Decimal(value.toString()).toFixed();
  }
  if (typeof value !== "string") throw new Error("余额字段不是有效金额");
  return new Decimal(amount(value));
}
export function decimalResult(value: Decimal, unit: string): BalanceResult {
  if (value.lt(0)) throw new Error("接口计算结果为负余额，未覆盖上次记录");
  return {
    balance: amount(value.toDecimalPlaces(12).toFixed()),
    unit,
    rawQuota: null,
  };
}
