import type { PlatformMetadata } from "../types";
export const metadata = {
  value: "newapi-token",
  label: "New API · 令牌额度",
  description: "使用模型 API Key，只查该令牌；与账户余额分开",
  group: "中转站",
  endpoint: "/api/usage/token",
  credential: "API Key",
  capabilities: {
    scope: "token",
    units: ["令牌配额", "令牌额度 (USD)", "令牌额度 (CNY)"],
    conversion: "quota",
    userId: "unused",
    customMapping: false,
  },
  compatibility: {
    status: "documented",
    contract:
      "code=true 或 success=true; data.total_available; unlimited_quota=false",
    notes: "无限额度拒绝记账；仅该令牌，不加入账户币种合计。",
  },
  verification: {
    fixturesVerifiedOn: "2026-10-03",
    docsReviewedOn: "2026-10-03",
    liveVerifiedOn: null,
    docs: ["https://doc.newapi.pro/en/api/token-usage/"],
  },
} as const satisfies PlatformMetadata;
