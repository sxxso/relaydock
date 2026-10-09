import type { PlatformMetadata, Provider } from "./adapters/types";
import { metadata as newapi } from "./adapters/newapi/metadata";
import { metadata as token } from "./adapters/newapi-token/metadata";
import { metadata as generic } from "./adapters/generic/metadata";
import { metadata as deepseek } from "./adapters/deepseek/metadata";
import { metadata as openrouter } from "./adapters/openrouter/metadata";
import { metadata as siliconflow } from "./adapters/siliconflow/metadata";
import { metadata as custom } from "./adapters/custom/metadata";
export type { Provider } from "./adapters/types";
// Client-safe metadata only. Do not import the server registry here.
export const platforms: PlatformMetadata[] = [
  {
    value: "manual",
    label: "手动记录",
    description: "适合任意站点，不发起接口请求",
    group: "记录",
    capabilities: {
      scope: "none",
      units: ["部署者确认单位"],
      conversion: "none",
      userId: "unused",
      customMapping: false,
    },
    compatibility: {
      status: "manual",
      contract: "只记录管理员输入，不发起余额请求",
      notes: "未知值不自动设为零。",
    },
    verification: {
      fixturesVerifiedOn: null,
      docsReviewedOn: null,
      liveVerifiedOn: null,
      docs: [],
    },
  },
  newapi,
  token,
  generic,
  deepseek,
  openrouter,
  siliconflow,
  custom,
];
export const platformOf = (provider: Provider) =>
  platforms.find((p) => p.value === provider)!;
