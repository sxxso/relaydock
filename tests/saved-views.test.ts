import { describe, expect, it } from "vitest";
import type { Account } from "../src/lib/validation";
import {
  DEFAULT_SAVED_VIEW_FILTERS,
  savedViewFiltersSchema,
  savedViewSchema,
} from "../src/lib/saved-views";
import { filterAccounts, isOlderThanSevenDays } from "../src/lib/account-filter";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: crypto.randomUUID(),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    name: "测试账号",
    alias: "",
    siteUrl: "https://fixture.invalid",
    apiUrl: "",
    managementUrl: "",
    consoleUrl: "",
    rechargeUrl: "",
    docsUrl: "",
    group: "工作",
    userId: "",
    mapOrder: 0,
    tags: [],
    notes: "",
    favorite: false,
    archived: false,
    provider: "manual",
    query: {
      timeoutSeconds: 10,
      path: "/user/balance",
      balancePath: "balance",
      subtractPath: "",
      divisor: "1",
      authHeader: "Authorization",
    },
    unit: "USD",
    lowThreshold: "10",
    quotaPerUnit: null,
    balance: "5",
    balanceUnit: "USD",
    lastSnapshotAt: "2026-10-01T00:00:00.000Z",
    balanceSource: "manual",
    balanceSnapshotId: crypto.randomUUID(),
    rawQuota: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    lastSyncError: null,
    hasCredential: false,
    lastQueryDiagnostic: null,
    lastSyncDiagnostic: null,
    ...overrides,
  };
}

describe("saved view filters", () => {
  it("normalizes an empty filter set to the current workspace defaults", () => {
    expect(savedViewFiltersSchema.parse({})).toEqual(DEFAULT_SAVED_VIEW_FILTERS);
  });

  it("filters low, active, group, currency and sorts from local account data", () => {
    const lowCny = account({ id: "low-cny", unit: "CNY", balanceUnit: "CNY", group: "工作" });
    const highCny = account({ id: "high-cny", unit: "CNY", balanceUnit: "CNY", balance: "20", group: "工作" });
    const lowUsd = account({ id: "low-usd", group: "工作" });
    const archived = account({ id: "archived", unit: "CNY", balanceUnit: "CNY", archived: true });

    expect(
      filterAccounts(
        [highCny, archived, lowUsd, lowCny],
        {
          ...DEFAULT_SAVED_VIEW_FILTERS,
          group: "工作",
          currency: "CNY",
          onlyLow: true,
          sort: "name",
        },
        Date.parse("2026-10-06T00:00:00.000Z"),
      ).map((a) => a.id),
    ).toEqual(["low-cny"]);
  });

  it("matches accounts with no record or a record at least seven days old", () => {
    const now = Date.parse("2026-10-06T00:00:00.000Z");
    expect(isOlderThanSevenDays(account({ lastSnapshotAt: null }), now)).toBe(true);
    expect(
      isOlderThanSevenDays(
        account({ lastSnapshotAt: "2026-09-29T00:00:00.000Z" }),
        now,
      ),
    ).toBe(true);
    expect(
      isOlderThanSevenDays(
        account({ lastSnapshotAt: "2026-10-01T00:00:01.000Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("keeps saved view records limited to name, filters and timestamps", () => {
    const view = savedViewSchema.parse({
      id: crypto.randomUUID(),
      name: "工作账户",
      filters: { ...DEFAULT_SAVED_VIEW_FILTERS, group: "工作" },
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(view.name).toBe("工作账户");
    expect(() =>
      savedViewSchema.parse({
        ...view,
        credential: "must-not-be-stored",
      }),
    ).toThrow();
  });
});



