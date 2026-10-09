import {
  buildRequest,
  responseBody,
  readPath,
  decimalValue,
  decimalResult,
} from "../shared";
import type { BalanceAdapter } from "../types";
import { metadata } from "./metadata";
export const adapter = {
  metadata,
  buildRequest: (account) => buildRequest(account, metadata),
  parse: (body, account) => {
    responseBody(body, account);
    const infos = readPath(body, "balance_infos");
    if (!Array.isArray(infos)) throw new Error("DeepSeek 余额结构无效");
    const matches = infos.filter(
      (i) => i && typeof i === "object" && i.currency === account.unit,
    );
    if (matches.length !== 1)
      throw new Error(
        "响应中没有唯一匹配的币种，请选择 CNY 或 USD；不会自动换汇",
      );
    return decimalResult(decimalValue(matches[0].total_balance), account.unit);
  },
} satisfies BalanceAdapter;
