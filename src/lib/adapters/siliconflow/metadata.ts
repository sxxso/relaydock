import type { PlatformMetadata } from "../types";
export const metadata = {
  value: "siliconflow",
  label: "SiliconFlow · 旧接口兼容",
  description: "官方已停用；仅适用于仍支持旧接口的兼容站点",
  group: "兼容与自定义",
  root: "https://api.siliconflow.cn",
  endpoint: "/v1/user/info",
  credential: "API Key",
  defaultUnit: "CNY",
  capabilities: {
    scope: "account",
    units: ["CNY"],
    conversion: "fixed",
    userId: "unused",
    customMapping: false,
  },
  compatibility: {
    status: "legacy",
    contract: "旧接口 data.totalBalance，以 CNY 计",
    notes:
      "官方公告 /user/info 于 2026-08-14 停止服务；只兼容仍提供旧合同的站点。",
  },
  verification: {
    fixturesVerifiedOn: "2026-10-03",
    docsReviewedOn: "2026-10-03",
    liveVerifiedOn: null,
    docs: ["https://docs.siliconflow.cn/docs/release-notes/overview"],
  },
} as const satisfies PlatformMetadata;
