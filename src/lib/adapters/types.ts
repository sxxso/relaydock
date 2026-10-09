import type { AccountDetails } from "../validation";
export type Provider = AccountDetails["provider"];
export type QueryProvider = Exclude<Provider, "manual">;
export interface PlatformMetadata {
  readonly value: Provider;
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly endpoint?: string;
  readonly root?: string;
  readonly credential?: string;
  readonly defaultUnit?: string;
  readonly capabilities: {
    readonly scope: "none" | "account" | "token" | "configured";
    readonly units: readonly string[];
    readonly conversion:
      "none" | "quota" | "selected" | "fixed" | "declarative";
    readonly userId: "optional" | "unused";
    readonly customMapping: boolean;
  };
  readonly compatibility: {
    readonly status: "manual" | "documented" | "site-defined" | "legacy";
    readonly contract: string;
    readonly notes: string;
  };
  readonly verification: {
    readonly fixturesVerifiedOn: string | null;
    readonly docsReviewedOn: string | null;
    readonly liveVerifiedOn: string | null;
    readonly docs: readonly string[];
  };
}
export interface BalanceRequest {
  requestProfile?: "atlas" | "cc-switch";
  url: string;
  timeoutSeconds: 10 | 20 | 30;
  authHeader: "Authorization" | "x-api-key" | "api-key";
  userId: string;
}
export interface BalanceResult {
  balance: string;
  unit: string;
  rawQuota: string | null;
}
// Trusted, static code. Methods receive no credential, transport or store.
export interface BalanceAdapter {
  readonly metadata: PlatformMetadata & { readonly value: QueryProvider };
  buildRequest(account: AccountDetails): BalanceRequest;
  parse(body: unknown, account: AccountDetails): BalanceResult;
}
