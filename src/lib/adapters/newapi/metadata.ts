import type { PlatformMetadata } from "../types";
export const metadata = {
  value: "newapi",
  label: "New API · 账户余额",
  description: "用户管理令牌 + 用户 ID；不是模型 API Key",
  group: "中转站",
  endpoint: "/api/user/self",
  credential: "用户管理令牌",
  capabilities: {
    scope: "account",
    units: ["配额", "已确认单位"],
    conversion: "quota",
    userId: "optional",
    customMapping: false,
  },
  compatibility: {
    status: "documented",
    contract: "success=true; data.quota 为非负整数",
    notes:
      "兼容响应合同，不保证所有 New API 分支或版本；系数由部署者确认。实站日期仅代表一次用户授权的代理部署验证，不代表所有站点已验证。",
  },
  verification: {
    fixturesVerifiedOn: "2026-10-03",
    docsReviewedOn: "2026-10-03",
    liveVerifiedOn: "2026-10-04",
    docs: [
      "https://doc.newapi.pro/en/api/fei-user/",
      "https://docs.newapi.pro/en/docs/api/management/user-management/user-self-get",
    ],
  },
} as const satisfies PlatformMetadata;
