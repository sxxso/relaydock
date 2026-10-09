import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { accountInput, accountDetails } from "../src/lib/validation";
import { platforms } from "../src/lib/platform-catalog";
import * as legacy from "../src/lib/new-api";

const root = resolve("src/lib/adapters");
const ids = [
  "newapi",
  "newapi-token",
  "generic",
  "deepseek",
  "openrouter",
  "siliconflow",
  "custom",
] as const;
async function registry() {
  const path = resolve(root, "index.ts");
  expect(existsSync(path), "independent adapter registry must exist").toBe(
    true,
  );
  return import(/* @vite-ignore */ path);
}
function fixture(id: string) {
  return JSON.parse(readFileSync(resolve(root, id, "fixtures.json"), "utf8"));
}
const account = (provider: string, options = {}) =>
  accountInput.parse({
    name: "合成夹具",
    siteUrl: "https://relay.example",
    provider,
    ...options,
  });

describe("independent platform adapter contracts", () => {
  it("exhaustively registers query providers, not manual or inherited object keys", async () => {
    const { balanceAdapters, adapterOf } = await registry();
    expect(Object.keys(balanceAdapters).sort()).toEqual([...ids].sort());
    expect(Object.keys(balanceAdapters).sort()).toEqual(
      accountDetails.shape.provider
        .removeDefault()
        .options.filter((p: string) => p !== "manual")
        .sort(),
    );
    for (const id of [
      "manual",
      "constructor",
      "__proto__",
      "toString",
      "unknown",
    ])
      expect(() => adapterOf(id)).toThrow();
  });
  it.each(ids)(
    "%s owns its request, capabilities and honest verification record",
    async (id) => {
      const { adapterOf } = await registry();
      const adapter = adapterOf(id),
        f = fixture(id);
      expect(f).toMatchObject({ provider: id, synthetic: true });
      const descriptor = platforms.find((p) => p.value === id)!;
      expect(adapter.metadata).toBe(descriptor);
      expect(descriptor.capabilities.scope).toBe(
        id === "newapi-token"
          ? "token"
          : ["generic", "custom"].includes(id)
            ? "configured"
            : "account",
      );
      expect(descriptor.verification.liveVerifiedOn).toBe(
        id === "newapi" ? "2026-10-04" : null,
      );
      if (id === "newapi")
        expect(descriptor.compatibility.notes).toContain("不代表所有站点");
      expect(descriptor.verification.fixturesVerifiedOn).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(descriptor.compatibility.contract.length).toBeGreaterThan(5);
      const input = account(id, f.request.account);
      const request = adapter.buildRequest(input);
      expect(request).toEqual(f.request.expected);
      expect(request).toEqual(legacy.buildBalanceRequest(input));
      expect(Object.keys(request).sort()).toEqual(
        ["url", "timeoutSeconds", "authHeader", "userId"].sort(),
      );
      expect(JSON.stringify(request)).not.toContain("credential");
    },
  );
  it.each(ids)(
    "%s parses all owned success, zero, rejected and invalid fixtures compatibly",
    async (id) => {
      const { parseBalance, adapterOf } = await registry(),
        f = fixture(id);
      expect(f.cases.some((c: any) => c.expected?.balance === "0")).toBe(true);
      expect(f.cases.some((c: any) => c.error === "provider_rejected")).toBe(
        true,
      );
      expect(f.cases.some((c: any) => c.error === "invalid_balance")).toBe(
        true,
      );
      for (const c of f.cases) {
        const input = account(id, c.account);
        const before = JSON.stringify({ input, body: c.body });
        if (c.expected) {
          expect(parseBalance(c.body, input), c.name).toEqual(c.expected);
          expect(adapterOf(id).parse(c.body, input), c.name).toEqual(
            c.expected,
          );
          expect(legacy.parseBalance(c.body, input), c.name).toEqual(
            c.expected,
          );
        } else {
          expect(() => parseBalance(c.body, input), c.name).toThrow();
          expect(() => adapterOf(id).parse(c.body, input), c.name).toThrow();
          try {
            parseBalance(c.body, input);
          } catch (e) {
            if (c.error === "provider_rejected")
              expect((e as any).code, c.name).toBe("provider_rejected");
            else expect((e as any).code, c.name).not.toBe("provider_rejected");
          }
        }
        expect(JSON.stringify({ input, body: c.body }), c.name).toBe(before);
      }
    },
  );
  it("keeps raw quota compatibility export and refuses manual response parsing", async () => {
    const { parseBalance } = await registry();
    expect(
      legacy.parseNewApi({ success: true, data: { quota: "0" } }, null, "USD"),
    ).toEqual({ balance: "0", unit: "配额", rawQuota: "0" });
    expect(() => parseBalance({ balance: 1 }, account("manual"))).toThrow();
  });
});
