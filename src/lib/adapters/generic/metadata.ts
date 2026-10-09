import type { PlatformMetadata } from "../types";
export const metadata = {
  value: "generic",
  label: "通用余额接口",
  description: "GET /user/balance，读取 balance",
  group: "中转站",
  endpoint: "/user/balance",
  credential: "API Key",
  capabilities: {
    scope: "configured",
    units: ["部署者确认单位"],
    conversion: "none",
    userId: "unused",
    customMapping: false,
  },
  compatibility: {
    status: "site-defined",
    contract: "顶层 balance 为非负金额字符串或安全数值",
    notes: "站点约定而非跨平台标准；不依据域名推断口径或单位。",
  },
  verification: {
    fixturesVerifiedOn: "2026-10-03",
    docsReviewedOn: null,
    liveVerifiedOn: null,
    docs: [],
  },
} as const satisfies PlatformMetadata;
