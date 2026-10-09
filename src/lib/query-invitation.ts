import { z } from "zod";
import { buildBalanceRequest } from "./adapters";
import { safeJsonRequest } from "./outbound";
import { queryRouteMode, type QueryRouteMode } from "./query-routing";
import { QueryFailure } from "./query-trace";
import type { AccountDetails } from "./validation";
import { invitationMessages, parseInvitationCode } from "./invitation";

export const invitationFetchInput = z.object({ expectedRevision: z.number().int().nonnegative(), expectedUpdatedAt: z.iso.datetime(), routeMode: queryRouteMode.optional() }).strict();
export function invitationEndpoint(account: AccountDetails) {
  const url = new URL(buildBalanceRequest(account).url);
  url.pathname = url.pathname.replace(/\/api\/user\/self$/, "") + "/api/user/aff";
  url.search = ""; url.hash = "";
  return url.toString();
}
export async function queryInvitation(account: AccountDetails, credential: string, routeMode: QueryRouteMode) {
  const code = parseInvitationCode(await safeJsonRequest(invitationEndpoint(account), credential, account.userId, {
    timeoutSeconds: account.query.timeoutSeconds, requestProfile: account.query.requestProfile || "atlas", routeMode,
  }));
  // A malformed provider can echo authentication material in its data field.
  // Valid-looking codes containing the PAT must never become public cache data.
  if (code.includes(credential) || code.includes(credential.replace(/^Bearer\s+/i, ""))) throw new Error("邀请接口未返回有效邀请码");
  return code;
}
export function invitationFailure(error: unknown) {
  if (error instanceof QueryFailure) {
    if (error.httpStatus === 404) return invitationMessages.unsupported;
    if (error.httpStatus === 401 || error.httpStatus === 403) return invitationMessages.unauthorized;
    if (error.code === "response_html" || error.code === "response_challenge") return invitationMessages.needsWeb;
  }
  return invitationMessages.failed;
}
