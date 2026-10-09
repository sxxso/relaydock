import type { PlatformMetadata } from "../types";
export const metadata = {
  value: "custom",
  label: "自定义余额接口",
  description: "同源 GET 字段映射或 /v1/usage 预设，不执行脚本",
  group: "兼容与自定义",
  credential: "查询密钥",
  capabilities: {
    scope: "configured",
    units: ["部署者确认单位"],
    conversion: "declarative",
    userId: "unused",
    customMapping: true,
  },
  compatibility: {
    status: "site-defined",
    contract:
      "fields: (balancePath - subtractPath) / divisor；usage: remaining ?? quota.remaining ?? balance，接口单位/有效状态；同源 GET",
    notes: "只接受已校验路径与字段，不执行 JavaScript；密钥不在 URL 中。",
  },
  verification: {
    fixturesVerifiedOn: "2026-10-04",
    docsReviewedOn: null,
    liveVerifiedOn: null,
    docs: [],
  },
} as const satisfies PlatformMetadata;
