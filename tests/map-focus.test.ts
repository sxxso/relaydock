import { describe, expect, it } from "vitest";
import * as management from "../src/lib/map-management";

type View = {
  selected: string | null;
  version: number;
  width: number;
  height: number;
  hasTarget: boolean;
  waiting?: boolean;
};
type Filters = {
  search: string;
  group: string;
  currency: string;
  favorites: boolean;
  onlyLow: boolean;
  archive: string;
};
const camera = (previous: View | null, next: View) => {
  expect(management).toHaveProperty("mapCameraAction");
  return (
    management as unknown as {
      mapCameraAction: (p: View | null, n: View) => string;
    }
  ).mapCameraAction(previous, next);
};
const reveal = (a: management.RevealAccount, f: Filters) => {
  expect(management).toHaveProperty("revealAccountFilters");
  return management.revealAccountFilters(a, f);
};
const view: View = {
  selected: "a",
  version: 1,
  width: 800,
  height: 570,
  hasTarget: true,
};
const filters: Filters = {
  search: "",
  group: "all",
  currency: "all",
  favorites: false,
  onlyLow: false,
  archive: "active",
};
const account = {
  name: "工作站",
  alias: "主账号",
  siteUrl: "https://fixture.invalid",
  group: "常用",
  tags: [],
  archived: false,
  favorite: false,
  balance: "10",
  unit: "USD",
  lowThreshold: "1",
};

describe("intentional map camera", () => {
  it("focuses a newly added account on initial map mount instead of fitting the world", () => {
    expect(camera(null, view)).toBe("focus");
    expect(camera(null, { ...view, selected: null, hasTarget: false })).toBe(
      "fit",
    );
  });
  it("waits for committed movement and focuses even when the same account stays selected", () => {
    expect(camera(view, { ...view, version: 2, waiting: true })).toBe("wait");
    expect(camera(view, { ...view, version: 2 })).toBe("focus");
  });
  it("does not recenter for ordinary geometry, balance, group drag or clear-selection changes", () => {
    expect(camera(view, { ...view })).toBe("keep");
    expect(camera(view, { ...view, selected: null, hasTarget: false })).toBe(
      "keep",
    );
    expect(
      camera({ ...view, selected: null }, { ...view, selected: null }),
    ).toBe("keep");
  });
  it("waits for the actual target, then focuses selection or resized viewport", () => {
    expect(camera(view, { ...view, selected: "b", hasTarget: false })).toBe(
      "wait",
    );
    expect(camera(view, { ...view, selected: "b" })).toBe("focus");
    expect(camera(view, { ...view, width: 500 })).toBe("focus");
  });
});
describe("reveal only hiding filters after a successful save", () => {
  it("keeps filters when the target is already visible", () => {
    const f = { ...filters, search: "工作", group: "常用", currency: "USD" };
    expect(reveal(account, f)).toEqual(f);
  });
  it("removes search, group, unit, favorite and low balance filters hiding the account", () => {
    expect(
      reveal(account, {
        search: "不存在",
        group: "备用",
        currency: "CNY",
        favorites: true,
        onlyLow: true,
        archive: "archived",
      }),
    ).toEqual(filters);
  });
  it("shows archived accounts without resetting unrelated matching filters", () => {
    expect(reveal({ ...account, archived: true }, filters)).toEqual({
      ...filters,
      archive: "archived",
    });
    expect(
      reveal(
        { ...account, balance: "0", favorite: true },
        { ...filters, favorites: true, onlyLow: true },
      ),
    ).toEqual({ ...filters, favorites: true, onlyLow: true });
  });
});
