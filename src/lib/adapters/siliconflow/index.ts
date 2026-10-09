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
    return decimalResult(
      decimalValue(readPath(body, "data.totalBalance")),
      "CNY",
    );
  },
} satisfies BalanceAdapter;
