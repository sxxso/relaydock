import { z } from "zod";
import { createHash } from "node:crypto";
import { buildBalanceRequest } from "./adapters";
import { safeCheckinPostRequest, safeJsonRequest } from "./outbound";
import { queryRouteMode, type QueryRouteMode } from "./query-routing";
import { QueryFailure } from "./query-trace";
import type { AccountDetails } from "./validation";
import { CheckinBusinessFailure, checkinFailureStatus, monthSchema, parseCheckinReward, parseCheckinStatus, type CheckinContext } from "./checkin";

export const checkinStatusInput = z.object({ month: monthSchema.optional(), routeMode: queryRouteMode.optional() }).strict();
export const checkinSubmitInput = z.object({ refreshBalance: z.boolean(), routeMode: queryRouteMode.optional() }).strict();
export const checkinBatchInput = checkinSubmitInput.extend({ ids: z.array(z.string().min(1).max(100)).min(1).max(500).refine(ids => new Set(ids).size === ids.length) }).strict();
export function checkinBase(account: AccountDetails) {
  const base = new URL(buildBalanceRequest(account).url);
  base.pathname = base.pathname.replace(/\/api\/user\/self$/, "") + "/api/user/checkin";
  base.search = ""; base.hash = "";
  return base;
}
export function checkinIdentity(account: AccountDetails) {
  const base = checkinBase(account);
  return createHash("sha256").update(JSON.stringify([base.origin.toLowerCase(), base.pathname, account.userId.replace(/^0+(?=\d)/, "")])).digest("hex");
}
export function checkinSite(account: AccountDetails) {
  const base = checkinBase(account);
  return createHash("sha256").update(base.origin.toLowerCase() + base.pathname).digest("hex");
}
export function checkinContext(account: AccountDetails, accountId: string, month?: string): CheckinContext {
  return { accountId, requestedMonth: month, quotaPerUnit: account.quotaPerUnit, unit: account.unit };
}
export function checkinErrorState(error: unknown): "failed" | "unsupported" | "needs_web" | "disabled" {
  if (error instanceof CheckinBusinessFailure && (error.reason === "disabled" || error.reason === "needs_web")) return error.reason;
  if (error instanceof QueryFailure) {
    if (error.httpStatus === 404) return "unsupported";
    if (error.httpStatus === 401 || error.httpStatus === 403 || error.code === "response_html" || error.code === "response_challenge") return "needs_web";
  }
  return "failed";
}
export function createCheckinReader(account: AccountDetails, credential: string, accountId: string, routeMode: QueryRouteMode) {
  const base = checkinBase(account), deadline = performance.now() + account.query.timeoutSeconds * 1000;
  const options = { timeoutSeconds: account.query.timeoutSeconds, requestProfile: account.query.requestProfile || "atlas" as const, routeMode, deadline };
  return {
    deadline,
    async status(month?: string) {
      const context = checkinContext(account, accountId, month), url = new URL(base);
      if (month) url.searchParams.set("month", monthSchema.parse(month));
      try { return parseCheckinStatus(await safeJsonRequest(url.toString(), credential, account.userId, options), context); }
      catch (error) { return checkinFailureStatus(context, checkinErrorState(error)); }
    },
    async submit() {
      return parseCheckinReward(await safeCheckinPostRequest(base.toString(), credential, account.userId, options));
    },
  };
}
export function knownSubmissionFailure(error: unknown) {
  // A validated business rejection or a definitive unsupported/auth response
  // did not perform the standard mutation. Every ambiguous failure stays barred.
  return error instanceof CheckinBusinessFailure || (error instanceof QueryFailure && [401, 403, 404, 429].includes(error.httpStatus ?? 0));
}
