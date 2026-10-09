import { expect, it } from "vitest";
import {
  newWizardDraft,
  wizardQueryInput,
  wizardSaveInput,
  wizardStepError,
  wizardPreview,
  wizardUnit,
  wizardCloseAllowed,
} from "../src/lib/account-wizard";
import { accountInput, draftQueryInput } from "../src/lib/validation";
it("does not dismiss the wizard during an in-flight test or save", () => {
  expect(wizardCloseAllowed(true, false)).toBe(false);
  expect(wizardCloseAllowed(false, true)).toBe(false);
  expect(wizardCloseAllowed(false, false)).toBe(true);
});

const draft = (patch = {}) => ({
  ...newWizardDraft(),
  name: " Atlas ",
  siteUrl: "https://fixture.example",
  ...patch,
});
it("does not save a new group with a blank name", () => {
  expect(
    wizardStepError(draft({ group: "  ", unitConfirmed: true }), 5, false),
  ).toMatch(/分组/);
});
it("starts with manual, unknown balance, no credentials or presumed conversion", () => {
  const d = newWizardDraft();
  expect(d.provider).toBe("manual");
  expect(d.credential).toBe("");
  expect(d.initialBalance).toBe("");
  expect(d.conversionConfirmed).toBe(false);
  expect(d.unitConfirmed).toBe(false);
});
it("tests only query fields, always raw quota before unit confirmation, never metadata or initial balance", () => {
  const q = wizardQueryInput(
    draft({
      provider: "newapi",
      credential: " fixture-secret ",
      quotaPerUnit: "500000",
      conversionConfirmed: true,
      unit: "CNY",
      group: "private-name",
    }),
  );
  expect(q).toMatchObject({
    provider: "newapi",
    credential: "fixture-secret",
    quotaPerUnit: null,
  });
  expect(q).not.toHaveProperty("name");
  expect(q).not.toHaveProperty("group");
  expect(q).not.toHaveProperty("initialBalance");
  expect(draftQueryInput.safeParse(q).success).toBe(true);
});
it("same-host account vs token remain explicitly separate payloads and unit labels", () => {
  expect(wizardQueryInput(draft({ provider: "newapi-token" })).provider).toBe(
    "newapi-token",
  );
  expect(wizardUnit(draft({ provider: "newapi" }))).toBe("配额");
  expect(wizardUnit(draft({ provider: "newapi-token" }))).toBe("令牌配额");
  expect(
    wizardUnit(
      draft({
        provider: "newapi-token",
        conversionConfirmed: true,
        unit: "CNY",
      }),
    ),
  ).toBe("令牌额度 (CNY)");
});
it("saving without conversion never serializes a suggested factor", () => {
  const p = wizardSaveInput(
    draft({
      provider: "newapi",
      quotaPerUnit: "500000",
      credential: "fixture",
      initialBalance: "99",
    }),
  );
  expect(p.quotaPerUnit).toBeNull();
  expect(p.initialBalance).toBeNull();
  expect(p.name).toBe("Atlas");
  expect(accountInput.safeParse(p).success).toBe(true);
});
it("manual balance zero is explicit, blank is unknown, and test results never become initial balances", () => {
  expect(wizardSaveInput(draft()).initialBalance).toBeNull();
  expect(wizardSaveInput(draft({ initialBalance: "0" })).initialBalance).toBe(
    "0",
  );
  expect(
    wizardSaveInput(draft({ provider: "generic", initialBalance: "99" }))
      .initialBalance,
  ).toBeNull();
});
it("preserves advanced entries and trims only the typed save fields", () => {
  const p = wizardSaveInput(
    draft({
      alias: " main ",
      tags: "a， b,a",
      notes: " note ",
      consoleUrl: "https://fixture.example/console",
      lowThreshold: "0",
      unit: "积分",
    }),
  );
  expect(p).toMatchObject({
    alias: "main",
    tags: ["a", "b"],
    notes: "note",
    lowThreshold: "0",
    unit: "积分",
  });
  expect(p).not.toHaveProperty("unitConfirmed");
  expect(p).not.toHaveProperty("unverifiedAccepted");
});
it("requires real address/name/custom mapping in the address step, not a credential just to save offline", () => {
  expect(wizardStepError(draft({ siteUrl: "bad" }), 2, false)).toBeTruthy();
  expect(
    wizardStepError(
      draft({
        provider: "custom",
        query: { ...newWizardDraft().query, path: "//evil.example" },
      }),
      2,
      false,
    ),
  ).toBeTruthy();
  expect(
    wizardStepError(draft({ provider: "newapi", credential: "" }), 2, false),
  ).toBe("");
});
it("requires unit/scope confirmation and a positive confirmed factor", () => {
  expect(wizardStepError(draft(), 4, false)).toContain("确认");
  expect(wizardStepError(draft({ unitConfirmed: true }), 4, false)).toBe("");
  expect(
    wizardStepError(
      draft({
        provider: "newapi",
        conversionConfirmed: true,
        quotaPerUnit: "",
        unitConfirmed: true,
      }),
      4,
      true,
    ),
  ).toBeTruthy();
  expect(
    wizardStepError(
      draft({
        provider: "newapi",
        conversionConfirmed: true,
        quotaPerUnit: "0",
        unitConfirmed: true,
      }),
      4,
      true,
    ),
  ).toBeTruthy();
});
it("requires explicit unverified acceptance for nonmanual save, even after an invalidated test", () => {
  const d = draft({ provider: "generic", unitConfirmed: true });
  expect(wizardStepError(d, 5, false)).toContain("未验证");
  expect(wizardStepError({ ...d, unverifiedAccepted: true }, 5, false)).toBe(
    "",
  );
  expect(wizardStepError(d, 5, true)).toBe("");
  expect(wizardStepError(draft({ unitConfirmed: true }), 5, false)).toBe("");
});
it("previews a confirmed conversion from exact raw quota, never from rounded screen numbers", () => {
  const r = { balance: "1000001", unit: "配额", rawQuota: "1000001" };
  expect(wizardPreview(draft({ provider: "newapi" }), r)).toEqual(r);
  expect(
    wizardPreview(
      draft({
        provider: "newapi",
        conversionConfirmed: true,
        quotaPerUnit: "500000",
        unit: "CNY",
      }),
      r,
    ),
  ).toEqual({ balance: "2.000002", unit: "CNY", rawQuota: "1000001" });
  expect(
    wizardPreview(
      draft({
        provider: "newapi-token",
        conversionConfirmed: true,
        quotaPerUnit: "500000",
        unit: "USD",
      }),
      r,
    )?.unit,
  ).toBe("令牌额度 (USD)");
  expect(
    wizardPreview(
      draft({
        provider: "newapi",
        conversionConfirmed: true,
        quotaPerUnit: "0",
      }),
      r,
    ),
  ).toBeNull();
});
it("respects fixed platform currency and retains DeepSeek's chosen test currency", () => {
  expect(
    wizardSaveInput(draft({ provider: "openrouter", unit: "CNY" })).unit,
  ).toBe("USD");
  expect(
    wizardSaveInput(draft({ provider: "siliconflow", unit: "USD" })).unit,
  ).toBe("CNY");
  expect(
    wizardQueryInput(draft({ provider: "deepseek", unit: "USD" })).unit,
  ).toBe("USD");
});
