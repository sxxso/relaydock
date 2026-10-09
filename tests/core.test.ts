import { describe, it, expect } from "vitest";
import {
  amount,
  totals,
  isLow,
  unitKey,
  displayAmount,
} from "../src/lib/money";
import { layoutIslands } from "../src/lib/map-layout";
import { parseNewApi } from "../src/lib/new-api";
import {
  isPublicAddress,
  validateTarget,
  validateResolved,
} from "../src/lib/outbound";
import {
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
} from "../src/lib/crypto";
import { accountInput, backupInput } from "../src/lib/validation";
const account = (
  id: string,
  balance: string | null,
  unit = "USD",
  siteUrl = "https://a.example",
) => ({
  id,
  name: id,
  group: "常用",
  balance,
  unit,
  siteUrl,
  archived: false,
  lowThreshold: null,
});
describe("precise balances", () => {
  it("formats only the integer part with separators", () => {
    expect(displayAmount("1234.123456", "USD")).toBe("$1,234.123456");
  });
  it("uses decimal strings, accepts zero and rejects invalid values", () => {
    expect(amount("0")).toBe("0");
    expect(amount("0.100000")).toBe("0.1");
    expect(() => amount("NaN")).toThrow();
    expect(() => amount("-1")).toThrow();
    expect(() => amount("1e100")).toThrow();
  });
  it("adds without floating point errors and keeps currencies apart", () => {
    expect(
      totals([
        account("a", "0.1"),
        account("b", "0.2"),
        account("c", "12", "CNY"),
      ]),
    ).toEqual({ USD: "0.3", CNY: "12" });
  });
  it("does not combine custom points across sites or unknown balances", () => {
    let a = account("a", "20", "积分"),
      b = account("b", "30", "积分", "https://b.example");
    expect(unitKey(a)).not.toBe(unitKey(b));
    expect(Object.values(totals([a, b, account("c", null)]))).toEqual([
      "20",
      "30",
    ]);
  });
  it("ignores archived accounts and recognizes a zero threshold", () => {
    expect(totals([{ ...account("a", "20"), archived: true }])).toEqual({});
    expect(isLow({ ...account("a", "0"), lowThreshold: "0" })).toBe(true);
    expect(isLow(account("b", null))).toBe(false);
  });
});
describe("stable island geometry", () => {
  it("is deterministic for 50 accounts and independent of balances", () => {
    let a = Array.from({ length: 50 }, (_, i) => ({
      ...account(String(i), "1"),
      group: ["常用", "备用", "实验"][i % 3],
    }));
    expect(layoutIslands(a)).toEqual(
      layoutIslands([...a].reverse().map((x) => ({ ...x, balance: "99" }))),
    );
    let out = layoutIslands(a);
    expect(out.nodes).toHaveLength(50);
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(50);
  });
});
describe("New API response fixtures", () => {
  it("converts confirmed quotas precisely", () => {
    expect(
      parseNewApi({ success: true, data: { quota: 500001 } }, "500000", "USD"),
    ).toEqual({ balance: "1.000002", unit: "USD", rawQuota: "500001" });
  });
  it("keeps raw quota unconverted and accepts zero", () => {
    expect(
      parseNewApi({ success: true, data: { quota: 0 } }, null, "USD").unit,
    ).toBe("配额");
    expect(
      parseNewApi({ success: true, data: { quota: 42 } }, null, "USD").balance,
    ).toBe("42");
  });
  it("rejects errors, negative, missing and unsafe numeric quota", () => {
    for (const value of [
      { success: false, data: { quota: 10 } },
      { success: true, data: {} },
      { success: true, data: { quota: -1 } },
      { success: true, data: { quota: 9007199254740992 } },
    ])
      expect(() => parseNewApi(value, null, "USD")).toThrow();
  });
});
describe("outbound SSRF policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
  ])("blocks %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public %s",
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );
  it("rejects URL credentials, schemes and unsafe resolved endpoints", () => {
    expect(() => validateTarget("file:///a")).toThrow();
    expect(() => validateTarget("https://user:secret@a.example")).toThrow();
    expect(() =>
      validateResolved(
        "a.example",
        [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        [],
      ),
    ).toThrow();
  });
  it.each([
    ["fd00:ec2::254", 6],
    ["fd00:0ec2:0000:0000:0000:0000:0000:0254", 6],
    ["100.100.100.200", 4],
    ["::ffff:100.100.100.200", 6],
  ])(
    "denies metadata %s even for allowlisted private hosts",
    (address, family) => {
      expect(() =>
        validateResolved(
          "allowed.example",
          [{ address: String(address), family: Number(family) }],
          ["allowed.example"],
        ),
      ).toThrow();
    },
  );
  it("allows ordinary private IPv6 when explicitly configured", () => {
    expect(() =>
      validateResolved(
        "allowed.example",
        [{ address: "fd00::123", family: 6 }],
        ["allowed.example"],
      ),
    ).not.toThrow();
  });
  it("requires explicit private allowlist, but never allows metadata", () => {
    expect(() =>
      validateResolved(
        "local.example",
        [{ address: "10.1.1.1", family: 4 }],
        ["local.example"],
      ),
    ).not.toThrow();
    expect(() =>
      validateResolved(
        "local.example",
        [{ address: "169.254.169.254", family: 4 }],
        ["local.example"],
      ),
    ).toThrow();
  });
});
describe("sensitive credentials", () => {
  it("hashes passwords and rejects wrong passwords", () => {
    let h = hashPassword("strong-password-123");
    expect(h).not.toContain("strong-password");
    expect(verifyPassword("strong-password-123", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });
  it("authenticated encryption detects tampering and wrong keys", () => {
    let key = Buffer.alloc(32, 1),
      e = encryptSecret("test-token", key);
    expect(e).not.toContain("test-token");
    expect(decryptSecret(e, key)).toBe("test-token");
    expect(() => decryptSecret(e, Buffer.alloc(32, 2))).toThrow();
  });
});
describe("input validation", () => {
  it("rejects reserved unit separators", () => {
    expect(() =>
      accountInput.parse({
        name: "A",
        siteUrl: "https://a.example",
        unit: "USD::other",
      }),
    ).toThrow();
  });
  it("allows multiple accounts for the same origin and trims metadata", () => {
    expect(
      accountInput.parse({
        name: " A ",
        siteUrl: "https://a.example",
        provider: "manual",
        unit: "USD",
      }).name,
    ).toBe("A");
  });
  it("rejects unknown backup version and leaked credential fields", () => {
    expect(() =>
      backupInput.parse({
        version: 999,
        accounts: [],
        snapshots: [],
        settings: {},
      }),
    ).toThrow();
    expect(() =>
      backupInput.parse({
        version: 1,
        accounts: [
          { id: "a", name: "A", siteUrl: "https://a.example", token: "secret" },
        ],
        snapshots: [],
        settings: {},
      }),
    ).toThrow();
  });
});
