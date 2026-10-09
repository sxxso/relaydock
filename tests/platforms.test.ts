import { describe, it, expect } from "vitest";
import { accountInput, backupInput } from "../src/lib/validation";
import * as adapters from "../src/lib/new-api";
import * as outbound from "../src/lib/outbound";
const base = { name: "多平台", siteUrl: "https://relay.example" };
describe("platform configuration and legacy compatibility", () => {
  it("rejects credential fragments as well as query parameters", () => {
    for (const key of ["access_token", "key", "auth", "session"])
      expect(
        accountInput.safeParse({
          ...base,
          siteUrl: "https://relay.example#" + key + "=fixture-url-secret",
        }).success,
      ).toBe(false);
  });
  it("rejects credentials in fallback site URLs and shortcut URLs", () => {
    for (const field of ["siteUrl", "consoleUrl", "rechargeUrl", "docsUrl"])
      expect(
        accountInput.safeParse({
          ...base,
          provider: "custom",
          [field]: "https://relay.example?token=fixture-url-secret",
        }).success,
      ).toBe(false);
  });
  it.each(["apiUrl", "managementUrl"])(
    "rejects credential-looking URL parameters in %s",
    (field) => {
      expect(
        accountInput.safeParse({
          ...base,
          [field]: "https://relay.example?token=fixture-url-secret",
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    "generic",
    "deepseek",
    "openrouter",
    "siliconflow",
    "custom",
    "newapi-token",
  ])("accepts %s without secrets in public config", (provider) => {
    expect(accountInput.safeParse({ ...base, provider }).success).toBe(true);
  });
  it("defaults old accounts to a ten-second safe query", () => {
    const account = accountInput.parse(base) as any;
    expect(account.query).toMatchObject({
      timeoutSeconds: 10,
      path: "/user/balance",
      balancePath: "balance",
      authHeader: "Authorization",
    });
  });
  it("accepts explicitly extended timeout and decimal mapping", () => {
    expect(
      accountInput.safeParse({
        ...base,
        provider: "custom",
        query: {
          timeoutSeconds: 30,
          path: "/wallet",
          balancePath: "data.balance",
          subtractPath: "data.used",
          divisor: "100",
        },
      }).success,
    ).toBe(true);
  });
  it.each([
    "//evil.example/path",
    "https://evil.example",
    "/wallet?token=secret",
    "/wallet#secret",
    "/\\evil",
    "/%2f%2fevil",
    "/x/../wallet",
  ])("rejects unsafe custom path %s", (path) => {
    expect(
      accountInput.safeParse({ ...base, provider: "custom", query: { path } })
        .success,
    ).toBe(false);
  });
  it.each([
    "__proto__.balance",
    "constructor",
    "data[0].balance",
    "x;process.exit()",
  ])("rejects executable/prototype extraction %s", (balancePath) => {
    expect(
      accountInput.safeParse({ ...base, query: { balancePath } }).success,
    ).toBe(false);
  });
  it("supports all background styles in backups and fills legacy settings", () => {
    for (const mapBackground of [
      "paper",
      "dots",
      "grid",
      "cross",
      "contours",
    ]) {
      expect(
        backupInput.safeParse({
          version: 1,
          accounts: [],
          snapshots: [],
          settings: { mapBackground },
        }).success,
      ).toBe(true);
    }
    expect(
      (
        backupInput.parse({
          version: 1,
          accounts: [],
          snapshots: [],
          settings: {},
        }).settings as any
      ).mapBackground,
    ).toBe("dots");
  });
});
describe("opt-in DNS-over-HTTPS answer validation", () => {
  const parse = (b: unknown, family: number) =>
    (outbound as any).parseDohAnswer(b, family);
  it("reads only valid A/AAAA records and ignores CNAME aliases", () => {
    expect(
      parse(
        {
          Status: 0,
          Answer: [
            { type: 5, data: "alias.example" },
            { type: 1, data: "8.8.8.8" },
          ],
        },
        4,
      ),
    ).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(
      parse(
        { Status: 0, Answer: [{ type: 28, data: "2606:4700:4700::1111" }] },
        6,
      ),
    ).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    expect(parse({ Status: 0 }, 6)).toEqual([]);
  });
  it("rejects DNS errors and invalid address/family combinations", () => {
    for (const b of [
      { Status: 3 },
      { Status: 0, Answer: [{ type: 1, data: "javascript:bad" }] },
      { Status: 0, Answer: [{ type: 1, data: "::1" }] },
    ])
      expect(() => parse(b, 4)).toThrow();
  });
  it("does not exempt private/metadata results from existing network restrictions", () => {
    const answers = parse(
      { Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] },
      4,
    );
    expect(() =>
      outbound.validateResolved("relay.example", answers, []),
    ).toThrow("私有");
  });
});
describe("balance platform request and extraction", () => {
  const parse = (provider: string, body: unknown, options = {}) =>
    (adapters as any).parseBalance(
      body,
      accountInput.parse({ ...base, provider, ...options }),
    );
  const request = (provider: string, options = {}) =>
    (adapters as any).buildBalanceRequest(
      accountInput.parse({ ...base, provider, ...options }),
    );
  it("normalizes New API management and model endpoints without duplicate paths", () => {
    for (const suffix of ["", "/v1", "/api", "/api/user/self"])
      expect(
        request("newapi", {
          managementUrl: "https://relay.example/proxy" + suffix,
        }).url,
      ).toBe("https://relay.example/proxy/api/user/self");
  });
  it("selects official defaults and keeps timeout at most thirty seconds", () => {
    expect(request("deepseek").url).toBe(
      "https://api.deepseek.com/user/balance",
    );
    expect(
      request("openrouter", {
        apiUrl: "https://openrouter.ai/api/v1",
        query: { timeoutSeconds: 30 },
      }),
    ).toMatchObject({
      url: "https://openrouter.ai/api/v1/credits",
      timeoutSeconds: 30,
    });
  });
  it("preserves New API raw quota and explicit conversion", () => {
    expect(
      parse("newapi", { success: true, data: { quota: 500000 } }),
    ).toMatchObject({ balance: "500000", unit: "配额", rawQuota: "500000" });
    expect(
      parse(
        "newapi",
        { success: true, data: { quota: "500000" } },
        { quotaPerUnit: "500000" },
      ),
    ).toMatchObject({ balance: "1", unit: "USD" });
  });
  it("distinguishes limited token quota from account money and rejects unlimited tokens", () => {
    expect(
      parse(
        "newapi-token",
        {
          code: true,
          data: { total_available: 250000, unlimited_quota: false },
        },
        { quotaPerUnit: "500000" },
      ),
    ).toMatchObject({ balance: "0.5", unit: "令牌额度 (USD)" });
    expect(() =>
      parse("newapi-token", {
        code: true,
        data: { total_available: 0, unlimited_quota: true },
      }),
    ).toThrow("无限");
    expect(() =>
      parse(
        "newapi-token",
        { code: true, data: { total_available: 1, unlimited_quota: false } },
        { quotaPerUnit: "1", unit: "一个超长的自定义余额单位名称" },
      ),
    ).toThrow("USD 或 CNY");
  });
  it("isolates DeepSeek currencies instead of summing or assuming USD", () => {
    const b = {
      is_available: false,
      balance_infos: [
        { currency: "CNY", total_balance: "0" },
        { currency: "USD", total_balance: "7.10" },
      ],
    };
    expect(parse("deepseek", b, { unit: "CNY" })).toMatchObject({
      balance: "0",
      unit: "CNY",
    });
    expect(() => parse("deepseek", b, { unit: "积分" })).toThrow("币种");
  });
  it("computes OpenRouter credits with decimal subtraction", () => {
    expect(
      parse("openrouter", {
        data: { total_credits: "0.3", total_usage: "0.1" },
      }),
    ).toMatchObject({ balance: "0.2", unit: "USD" });
    expect(() =>
      parse("openrouter", {
        data: { total_credits: "0.1", total_usage: "0.2" },
      }),
    ).toThrow("负");
  });
  it("supports zero generic balance and structured custom fields/divisor", () => {
    expect(parse("generic", { balance: 0 }, { unit: "CNY" })).toMatchObject({
      balance: "0",
      unit: "CNY",
    });
    expect(
      parse(
        "custom",
        { data: { wallets: [{ amount: "900", used: "200" }] } },
        {
          query: {
            balancePath: "data.wallets.0.amount",
            subtractPath: "data.wallets.0.used",
            divisor: "100",
          },
        },
      ),
    ).toMatchObject({ balance: "7", unit: "USD" });
  });
  it("rejects failed, missing, invalid and unsafe values without manufacturing zero", () => {
    for (const b of [
      { success: false, balance: 10 },
      { error: { message: "secret" }, balance: 10 },
      { balance: null },
      { balance: true },
      { balance: 9007199254740992 },
      { balance: "NaN" },
    ])
      expect(() => parse("generic", b)).toThrow();
  });
  it("parses SiliconFlow legacy-compatible data without claiming official availability", () => {
    expect(
      parse("siliconflow", { status: true, data: { totalBalance: "12.5" } }),
    ).toMatchObject({ balance: "12.5", unit: "CNY" });
  });
});
