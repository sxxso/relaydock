import { parseBalance, buildBalanceRequest } from "./adapters";
import { safeJsonRequest } from "./outbound";
import { QueryFailure, QueryTrace } from "./query-trace";
import { publicQueryError, type QueryDiagnostic } from "./query-diagnostics";
import type { AccountDetails } from "./validation";
import type { QueryRouteMode } from "./query-routing";

export class BalanceQueryFailure extends Error {
  readonly status: number;
  constructor(readonly diagnostic: QueryDiagnostic) {
    super(publicQueryError(diagnostic));
    this.status = ["missing_credential", "invalid_config"].includes(
      diagnostic.code,
    )
      ? 400
      : 502;
  }
}

// Queries only; callers own persistence. Draft testing cannot touch the store.
export async function queryBalance(
  account: AccountDetails,
  credential: string | null | undefined,
  operation: "test" | "sync",
  routeMode: QueryRouteMode = process.env.RELAYDOCK_QUERY_PROXY_URL
    ? "proxy"
    : "direct",
  deadline?: number,
) {
  const trace = new QueryTrace({
    provider: account.provider,
    operation,
    routeMode,
    requestProfile: account.query.requestProfile || "atlas",
    timeoutSeconds: account.query.timeoutSeconds,
    dnsMode:
      process.env.RELAYDOCK_DNS_MODE === "cloudflare" ? "cloudflare" : "system",
  });
  try {
    if (!credential)
      throw new QueryFailure("missing_credential", "missing credential");
    let request: ReturnType<typeof buildBalanceRequest>;
    try {
      request = buildBalanceRequest(account);
    } catch {
      throw new QueryFailure("invalid_config", "invalid query configuration");
    }
    const data = await safeJsonRequest(
      request.url,
      credential,
      request.userId,
      { ...request, trace, routeMode, ...(deadline === undefined ? {} : { deadline }) },
    );
    trace.begin("parse");
    let result: ReturnType<typeof parseBalance>;
    try {
      result = parseBalance(data, account);
    } catch (e) {
      if (e instanceof QueryFailure) throw e;
      throw new QueryFailure("invalid_balance", "invalid balance response");
    }
    trace.end();
    return { result, diagnostic: trace.finish() };
  } catch (e) {
    const failure =
      e instanceof QueryFailure
        ? e
        : new QueryFailure("query_failed", "query failed");
    throw new BalanceQueryFailure(trace.finish(failure));
  }
}
