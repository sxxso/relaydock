import type { PlatformMetadata } from "../types";
export const metadata = {
  value: "openrouter",
  label: "OpenRouter",
  description: "账户总额度减已用金额，需要 Management Key",
  group: "平台余额",
  root: "https://openrouter.ai",
  endpoint: "/api/v1/credits",
  credential: "Management Key",
  defaultUnit: "USD",
  capabilities: {
    scope: "account",
    units: ["USD"],
    conversion: "fixed",
    userId: "unused",
    customMapping: false,
  },
  compatibility: {
    status: "documented",
    contract: "data.total_credits - data.total_usage，以 USD 计",
    notes: "需要管理密钥；负结果拒绝覆盖旧余额。",
  },
  verification: {
    fixturesVerifiedOn: "2026-10-03",
    docsReviewedOn: "2026-10-03",
    liveVerifiedOn: null,
    docs: [
      "https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits",
    ],
  },
} as const satisfies PlatformMetadata;
