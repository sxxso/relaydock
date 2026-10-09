import type { Provider } from "./platform-catalog";
import {
  accountDetails,
  accountInput,
  querySchema,
  type AccountDetails,
} from "./validation";
import { amount, tokenBalanceUnit } from "./money";
import Decimal from "decimal.js";
export type WizardDraft = {
  provider: Provider;
  query: AccountDetails["query"];
  name: string;
  alias: string;
  siteUrl: string;
  apiUrl: string;
  managementUrl: string;
  credential: string;
  userId: string;
  unit: string;
  quotaPerUnit: string;
  group: string;
  tags: string;
  notes: string;
  consoleUrl: string;
  rechargeUrl: string;
  docsUrl: string;
  initialBalance: string;
  lowThreshold: string;
  conversionConfirmed: boolean;
  unitConfirmed: boolean;
  unverifiedAccepted: boolean;
};
export type TestBalance = {
  balance: string;
  unit: string;
  rawQuota: string | null;
};
export const wizardCloseAllowed = (testing: boolean, saving: boolean) =>
  !testing && !saving;
export function newWizardDraft(): WizardDraft {
  return {
    provider: "manual",
    query: querySchema.parse({}),
    name: "",
    alias: "",
    siteUrl: "",
    apiUrl: "",
    managementUrl: "",
    credential: "",
    userId: "",
    unit: "USD",
    quotaPerUnit: "",
    group: "常用",
    tags: "",
    notes: "",
    consoleUrl: "",
    rechargeUrl: "",
    docsUrl: "",
    initialBalance: "",
    lowThreshold: "",
    conversionConfirmed: false,
    unitConfirmed: false,
    unverifiedAccepted: false,
  };
}
export const quotaProvider = (provider: Provider) =>
  provider === "newapi" || provider === "newapi-token";
const configuredUnit = (d: WizardDraft) =>
  d.provider === "openrouter"
    ? "USD"
    : d.provider === "siliconflow"
      ? "CNY"
      : d.unit.trim();
export function wizardQueryInput(d: WizardDraft) {
  return {
    provider: d.provider,
    siteUrl: d.siteUrl.trim(),
    apiUrl: d.apiUrl.trim(),
    managementUrl: d.managementUrl.trim(),
    userId: d.provider === "newapi" ? d.userId.trim() : "",
    query: { ...d.query },
    unit: quotaProvider(d.provider) ? "USD" : configuredUnit(d),
    quotaPerUnit: null,
    ...(d.credential.trim() ? { credential: d.credential.trim() } : {}),
  };
}
export function wizardSaveInput(d: WizardDraft) {
  return {
    ...wizardQueryInput(d),
    name: d.name.trim(),
    alias: d.alias.trim(),
    group: d.group.trim() || "未分组",
    tags: [
      ...new Set(
        d.tags
          .split(/[,，]/)
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ],
    notes: d.notes.trim(),
    consoleUrl: d.consoleUrl.trim(),
    rechargeUrl: d.rechargeUrl.trim(),
    docsUrl: d.docsUrl.trim(),
    unit: configuredUnit(d),
    quotaPerUnit:
      quotaProvider(d.provider) && d.conversionConfirmed
        ? d.quotaPerUnit.trim()
        : null,
    lowThreshold: d.lowThreshold.trim() || null,
    initialBalance:
      d.provider === "manual" ? d.initialBalance.trim() || null : null,
  };
}
export function wizardStepError(
  d: WizardDraft,
  step: number,
  verified: boolean,
): string {
  if (step === 2) {
    const { credential: _credential, ...query } = wizardQueryInput(d);
    const check = accountDetails.safeParse({
      ...query,
      name: d.name.trim(),
      alias: d.alias.trim(),
    });
    return check.success
      ? ""
      : check.error.issues[0]?.message || "请检查地址与查询配置";
  }
  if (step === 4 || step === 5) {
    if (step === 5 && !d.group.trim()) return "请选择已有分组或填写新分组名称";
    const check = accountInput.safeParse(wizardSaveInput(d));
    if (!check.success) return check.error.issues[0]?.message || "请检查配置";
    if (!d.unitConfirmed) return "请确认余额单位与查询口径";
    if (
      step === 5 &&
      d.provider !== "manual" &&
      !verified &&
      !d.unverifiedAccepted
    )
      return "请确认保存未验证配置，或返回点击测试";
  }
  return "";
}
export function wizardUnit(d: WizardDraft): string {
  const unit =
    quotaProvider(d.provider) && !d.conversionConfirmed
      ? "配额"
      : configuredUnit(d);
  return d.provider === "newapi-token" ? tokenBalanceUnit(unit) : unit;
}
export function wizardPreview(
  d: WizardDraft,
  r: TestBalance,
): TestBalance | null {
  if (!quotaProvider(d.provider) || !d.conversionConfirmed) return r;
  try {
    if (r.rawQuota === null) return null;
    const divisor = new Decimal(amount(d.quotaPerUnit.trim()));
    if (divisor.lte(0)) return null;
    return {
      balance: new Decimal(amount(r.rawQuota))
        .div(divisor)
        .toDecimalPlaces(12)
        .toFixed(),
      unit: wizardUnit(d),
      rawQuota: r.rawQuota,
    };
  } catch {
    return null;
  }
}
