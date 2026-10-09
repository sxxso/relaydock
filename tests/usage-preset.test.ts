import { describe, expect, it } from "vitest";
import { accountDetails, querySchema } from "../src/lib/validation";
import { buildBalanceRequest, parseBalance } from "../src/lib/adapters";
const account = () =>
  accountDetails.parse({
    name: "usage fixture",
    siteUrl: "https://usage.example",
    provider: "custom",
    unit: "CNY",
    query: { path: "/v1/usage", extractionMode: "usage" },
  });
describe("declarative CC Switch usage preset", () => {
  it.each([
    { remaining: "0", unit: "CNY" },
    { quota: { remaining: "0", unit: "CNY" } },
    { balance: "0", unit: "CNY" },
  ])("preserves zero in candidate fields", (body) =>
    expect(parseBalance(body, account())).toMatchObject({
      balance: "0",
      unit: "CNY",
    }),
  );
  it("uses nullish precedence and response units rather than account unit", () => {
    expect(
      parseBalance(
        {
          remaining: null,
          quota: { remaining: "12.125", unit: "USD" },
          balance: "99",
        },
        account(),
      ),
    ).toMatchObject({ balance: "12.125", unit: "USD" });
    expect(
      parseBalance(
        { remaining: "4", quota: { remaining: "5" }, balance: "6" },
        account(),
      ),
    ).toMatchObject({ balance: "4", unit: "USD" });
  });
  it("does not skip malformed candidate or guess missing as zero", () => {
    expect(() =>
      parseBalance({ remaining: "bad", balance: "4" }, account()),
    ).toThrow();
    expect(() => parseBalance({}, account())).toThrow();
    expect(() => parseBalance({ balance: "4", unit: "" }, account())).toThrow();
  });
  it("checks the chosen validity flag strictly, without script execution", () => {
    for (const body of [
      { remaining: "2", is_active: false },
      { remaining: "2", isValid: false },
      { remaining: "2", is_active: "false" },
    ])
      expect(() => parseBalance(body, account())).toThrow();
    expect(
      parseBalance(
        { remaining: "2", is_active: true, isValid: false },
        account(),
      ).balance,
    ).toBe("2");
    expect(
      querySchema.safeParse({ extractionMode: "eval", script: "fetch()" })
        .success,
    ).toBe(false);
  });
  it("preserves existing configured mapping behavior", () => {
    const a = accountDetails.parse({
      name: "manual mapping",
      siteUrl: "https://usage.example",
      provider: "custom",
      unit: "积分",
      query: {
        path: "/wallet",
        balancePath: "data.balance",
        subtractPath: "data.used",
        divisor: "100",
      },
    });
    expect(
      parseBalance({ data: { balance: "1000", used: "200" } }, a),
    ).toMatchObject({ balance: "8", unit: "积分" });
  });
  it("keeps New API route/ID, explicit conversion and raw unknown unit", () => {
    const a = accountDetails.parse({
      name: "newapi",
      siteUrl: "https://usage.example",
      managementUrl: "https://usage.example/v1",
      provider: "newapi",
      userId: "123",
      quotaPerUnit: "500000",
      unit: "USD",
    });
    expect(buildBalanceRequest(a)).toMatchObject({
      url: "https://usage.example/api/user/self",
      userId: "123",
      authHeader: "Authorization",
    });
    expect(
      parseBalance(
        {
          success: true,
          data: { quota: 625000, used_quota: 125000, group: "default" },
        },
        a,
      ),
    ).toMatchObject({ balance: "1.25", unit: "USD", rawQuota: "625000" });
    expect(
      parseBalance(
        { success: true, data: { quota: 625000 } },
        { ...a, quotaPerUnit: null },
      ),
    ).toMatchObject({ balance: "625000", unit: "配额" });
    expect(() =>
      parseBalance({ success: false, message: "fixture-secret" }, a),
    ).toThrow(/拒绝/);
  });
});
