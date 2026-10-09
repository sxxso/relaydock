import type { Store } from "./store";
import { parseQueryProxy } from "./outbound-proxy";
import { queryRouteMode, type QueryRoutingStatus } from "./query-routing";

export function queryRoutingStatus(
  store: Pick<Store, "getMeta">,
): QueryRoutingStatus {
  const input = process.env.RELAYDOCK_QUERY_PROXY_URL;
  const proxyConfigured = input !== undefined && input !== "";
  let proxyValid = false;
  try {
    proxyValid = parseQueryProxy(input) !== null;
  } catch {
    // Never surface the configured URL or a parser exception to the browser.
  }
  const saved = queryRouteMode.safeParse(store.getMeta("queryRoute"));
  return {
    mode: saved.success ? saved.data : proxyConfigured ? "proxy" : "direct",
    proxyConfigured,
    proxyValid,
  };
}
