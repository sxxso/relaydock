import Decimal from "decimal.js";
import { amount } from "../../money";
import { buildRequest, responseBody } from "../shared";
import type { BalanceAdapter, BalanceResult } from "../types";
import { metadata } from "./metadata";
export function parseNewApi(
  body: unknown,
  quotaPerUnit: string | null,
  unit: string,
): BalanceResult {
  const b = body as { success?: boolean; data?: { quota?: unknown } };
  if (b?.success !== true || !b.data) throw new Error("站点返回的用户信息无效");
  const q = b.data.quota;
  if (typeof q === "number" && (!Number.isSafeInteger(q) || q < 0))
    throw new Error("站点配额超出安全数值范围");
  if (typeof q !== "number" && typeof q !== "string")
    throw new Error("站点响应缺少配额");
  const raw = amount(String(q));
  if (!/^\d+$/.test(raw)) throw new Error("配额须为整数");
  if (quotaPerUnit !== null && new Decimal(amount(quotaPerUnit)).lte(0))
    throw new Error("换算系数须大于零");
  return {
    balance:
      quotaPerUnit === null
        ? raw
        : amount(
            new Decimal(raw).div(quotaPerUnit).toDecimalPlaces(12).toFixed(),
          ),
    unit: quotaPerUnit === null ? "配额" : unit,
    rawQuota: raw,
  };
}
export const adapter = {
  metadata,
  buildRequest: (account) => buildRequest(account, metadata),
  parse: (body, account) => {
    responseBody(body, account);
    return parseNewApi(body, account.quotaPerUnit, account.unit);
  },
} satisfies BalanceAdapter;
