import type { AccountDetails } from "../validation";
import type { BalanceAdapter, QueryProvider } from "./types";
import { adapter as newapi } from "./newapi";
import { adapter as token } from "./newapi-token";
import { adapter as generic } from "./generic";
import { adapter as deepseek } from "./deepseek";
import { adapter as openrouter } from "./openrouter";
import { adapter as siliconflow } from "./siliconflow";
import { adapter as custom } from "./custom";
// No user scripts, discovery or runtime module loading.
export const balanceAdapters = {
  newapi,
  "newapi-token": token,
  generic,
  deepseek,
  openrouter,
  siliconflow,
  custom,
} satisfies Record<QueryProvider, BalanceAdapter>;
export function adapterOf(provider: string): BalanceAdapter {
  if (!Object.prototype.hasOwnProperty.call(balanceAdapters, provider))
    throw new Error(
      provider === "manual" ? "手动账号无需接口查询" : "请选择支持的查询模板",
    );
  return balanceAdapters[provider as QueryProvider];
}
export function buildBalanceRequest(account: AccountDetails) {
  return adapterOf(account.provider).buildRequest(account);
}
export function parseBalance(body: unknown, account: AccountDetails) {
  return adapterOf(account.provider).parse(body, account);
}
