import type { PlatformMetadata } from "../types";
export const metadata = {
  value: "deepseek",
  label: "DeepSeek",
  description: "按所选币种读取账户可用余额",
  group: "平台余额",
  root: "https://api.deepseek.com",
  endpoint: "/user/balance",
  credential: "API Key",
  defaultUnit: "CNY",
  capabilities: {
    scope: "account",
    units: ["CNY", "USD"],
    conversion: "selected",
    userId: "unused",
    customMapping: false,
  },
  compatibility: {
    status: "documented",
    contract: "balance_infos 中唯一 currency 匹配项的 total_balance",
    notes: "is_available=false 不代表未知；不混加币种、不换汇。",
  },
  verification: {
    fixturesVerifiedOn: "2026-10-03",
    docsReviewedOn: "2026-10-03",
    liveVerifiedOn: null,
    docs: ["https://api-docs.deepseek.com/api/get-user-balance/"],
  },
} as const satisfies PlatformMetadata;
