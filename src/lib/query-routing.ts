import { z } from "zod";

export const queryRouteMode = z.enum(["direct", "proxy"]);
export type QueryRouteMode = z.infer<typeof queryRouteMode>;
// Public status deliberately contains no endpoint, credentials or connectivity claim.
export type QueryRoutingStatus = {
  mode: QueryRouteMode;
  proxyConfigured: boolean;
  proxyValid: boolean;
};
export const queryRouteInput = z.object({ mode: queryRouteMode }).strict();
export const queryRouteRequest = z
  .object({ routeMode: queryRouteMode.optional() })
  .strict();
