import { buildRequest, responseBody, readPath } from "../shared";
import { parseNewApi } from "../newapi";
import type { BalanceAdapter } from "../types";
import { metadata } from "./metadata";
export const adapter = {
  metadata,
  buildRequest: (account) => buildRequest(account, metadata),
  parse: (body, account) => {
    const b = responseBody(body, account);
    if (account.quotaPerUnit && !["USD", "CNY"].includes(account.unit))
      throw new Error(
        "令牌金额换算只支持 USD 或 CNY；其他单位请保留原始令牌配额",
      );
    if (b.code !== true && b.success !== true)
      throw new Error("站点不支持此令牌额度接口，改用账户管理令牌查询");
    if (readPath(body, "data.unlimited_quota") !== false)
      throw new Error("此令牌为无限额度，不能作为账户余额记录，请使用管理令牌");
    const result = parseNewApi(
      {
        success: true,
        data: { quota: readPath(body, "data.total_available") },
      },
      account.quotaPerUnit,
      account.unit,
    );
    return {
      ...result,
      unit: account.quotaPerUnit ? `令牌额度 (${account.unit})` : "令牌配额",
    };
  },
} satisfies BalanceAdapter;
