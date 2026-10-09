import { querySchema, unitSchema } from "../../validation";
import { QueryFailure } from "../../query-trace";
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
    const q = querySchema.parse(account.query || {});
    const b = responseBody(body, account, q.extractionMode !== "usage");
    if (q.extractionMode === "usage") {
      const validity = b.is_active ?? b.isValid ?? true;
      if (validity !== true)
        throw new QueryFailure(
          "provider_rejected",
          "站点未确认账户有效，余额未覆盖",
        );
      const quota =
        b.quota && typeof b.quota === "object" && !Array.isArray(b.quota)
          ? (b.quota as Record<string, unknown>)
          : {};
      const remaining = b.remaining ?? quota.remaining ?? b.balance;
      const unit = unitSchema.parse(b.unit ?? quota.unit ?? "USD");
      return decimalResult(decimalValue(remaining), unit);
    }
    let value = decimalValue(readPath(body, q.balancePath));
    if (q.subtractPath)
      value = value.minus(decimalValue(readPath(body, q.subtractPath)));
    return decimalResult(value.div(q.divisor), account.unit);
  },
} satisfies BalanceAdapter;
