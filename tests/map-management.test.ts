import { describe, expect, it } from "vitest";
import { layoutIslands } from "../src/lib/map-layout";
import {
  gridSampling,
  fitBounds,
  overviewBounds,
  overviewPoint,
  viewportBounds,
  retainVisibleSelection,
  matchesSearch,
  minimumZoom,
} from "../src/lib/map-management";

const accounts = (count: number, groups = 8) =>
  Array.from({ length: count }, (_, i) => ({
    id: `id-${String(i).padStart(4, "0")}`,
    group: `群岛-${i % groups}`,
  }));

describe("stable management geometry", () => {
  it.each([4, 50, 200, 500])(
    "lays out %i accounts without overlapping islands",
    (n) => {
      const input = accounts(n),
        g = layoutIslands(input);
      expect(g.nodes).toHaveLength(n);
      expect(layoutIslands([...input].reverse())).toEqual(g);
      for (const island of g.islands) {
        expect(island.x + island.width).toBeLessThanOrEqual(g.width);
        expect(island.y + island.height).toBeLessThanOrEqual(g.height);
        for (const other of g.islands.filter((o) => o.name !== island.name)) {
          expect(
            island.x + island.width <= other.x ||
              other.x + other.width <= island.x ||
              island.y + island.height <= other.y ||
              other.y + other.height <= island.y,
          ).toBe(true);
        }
      }
      expect(new Set(g.nodes.map((p) => `${p.x},${p.y}`)).size).toBe(n);
    },
  );
  it("uses wider groups for 200/500 instead of a permanent three-column tower", () => {
    const g = layoutIslands(accounts(500, 1));
    expect(new Set(g.nodes.map((p) => p.x)).size).toBe(8);
    const camera = fitBounds(
      { x: 0, y: 0, width: g.width, height: g.height },
      { width: 375, height: 480 },
    );
    expect(camera.k * g.height).toBeLessThanOrEqual(480);
    expect(camera.k).toBeGreaterThanOrEqual(0.02);
  });
  it("ignores amounts, labels, order and folding when the geometry input is the same IDs/groups", () => {
    const input = accounts(200);
    const before = layoutIslands(input);
    const updated = input.map((a, i) => ({
      ...a,
      balance: String(i),
      name: `新名 ${i}`,
      collapsed: i % 2 === 0,
    }));
    expect(layoutIslands(updated.reverse())).toEqual(before);
  });
  it("fits all 500 independent groups, not only 500 accounts in a few groups", () => {
    const g = layoutIslands(accounts(500, 500));
    const size = { width: 375, height: 480 };
    const t = fitBounds(g, size);
    expect(g.height * t.k).toBeLessThanOrEqual(size.height - 60 + 0.001);
    expect(g.width * t.k).toBeLessThanOrEqual(size.width - 60 + 0.001);
    for (const n of g.nodes) {
      expect(t.x + n.x * t.k).toBeGreaterThanOrEqual(0);
      expect(t.x + n.x * t.k).toBeLessThanOrEqual(size.width);
      expect(t.y + n.y * t.k).toBeGreaterThanOrEqual(0);
      expect(t.y + n.y * t.k).toBeLessThanOrEqual(size.height);
    }
  });
  it("fits a mixed 64-account group and 436 single-account groups", () => {
    const input = accounts(500, 500).map((a, i) => ({
      ...a,
      group: i < 64 ? "共享大组" : a.group,
    }));
    const g = layoutIslands(input),
      size = { width: 375, height: 480 };
    const t = fitBounds(g, size);
    expect(g.width * t.k).toBeLessThanOrEqual(size.width - 60 + 0.001);
    expect(g.height * t.k).toBeLessThanOrEqual(size.height - 60 + 0.001);
    for (const n of g.nodes) {
      expect(t.x + n.x * t.k).toBeGreaterThanOrEqual(0);
      expect(t.x + n.x * t.k).toBeLessThanOrEqual(size.width);
      expect(t.y + n.y * t.k).toBeGreaterThanOrEqual(0);
      expect(t.y + n.y * t.k).toBeLessThanOrEqual(size.height);
    }
  });
});

describe("adaptive grid and overview camera", () => {
  it("fits and locates negative islands using the actual four-way world bounds", () => {
    const g = layoutIslands(accounts(4, 2), [{ name: "群岛-0", x: -1200, y: -900 }]);
    expect(g).toMatchObject({ x: -1255, y: -960 });
    const world = g as typeof g & { x: number; y: number };
    const size = { width: 800, height: 600 };
    const t = fitBounds(world, size);
    for (const n of g.nodes) {
      expect(t.x + n.x * t.k).toBeGreaterThanOrEqual(0);
      expect(t.y + n.y * t.k).toBeGreaterThanOrEqual(0);
      expect(t.x + n.x * t.k).toBeLessThanOrEqual(size.width);
      expect(t.y + n.y * t.k).toBeLessThanOrEqual(size.height);
    }
    const domain = overviewBounds(world);
    expect(overviewPoint({ x: 85, y: 55 }, { width: 170, height: 110 }, domain, world))
      .toEqual({ x: world.x + world.width / 2, y: world.y + world.height / 2 });
    expect(overviewPoint({ x: -500, y: -500 }, { width: 170, height: 110 }, domain, world))
      .toEqual({ x: world.x, y: world.y });
    expect(viewportBounds({ x: 1000, y: 800, k: 1 }, { width: 200, height: 150 }, world))
      .toEqual({ x: -1000, y: -800, width: 200, height: 150 });
  });
  it("fits arbitrarily large finite worlds without a fixed minimum zoom cutting them off", () => {
    const g = { x: 0, y: 0, width: 100000, height: 1000000 };
    const t = fitBounds(g, { width: 375, height: 480 });
    expect(t.k).toBeGreaterThan(0);
    expect(t.k * g.width).toBeLessThanOrEqual(315);
    expect(t.k * g.height).toBeLessThanOrEqual(420);
    expect(minimumZoom(g, { width: 375, height: 480 })).toBeLessThanOrEqual(
      t.k,
    );
  });
  it.each([32, 36, 40, 48])(
    "keeps base %i spacing legible at near/far zoom",
    (base) => {
      for (const k of [0.00042, 0.006, 0.02, 0.06, 0.2, 0.5, 1, 1.8, 2.5]) {
        const sample = gridSampling(k, base);
        expect(sample.screenSpacing).toBeGreaterThanOrEqual(24);
        expect(sample.screenSpacing).toBeLessThan(48.0001);
        expect(Number.isInteger(Math.log2(sample.multiplier))).toBe(true);
      }
    },
  );
  it("fits group bounds centered without exceeding the zoom limits", () => {
    const b = { x: 50, y: 75, width: 100, height: 150 },
      s = { width: 800, height: 550 };
    const t = fitBounds(b, s);
    expect(t.k).toBe(1.3);
    expect(t.x + (b.x + b.width / 2) * t.k).toBe(s.width / 2);
    expect(t.y + (b.y + b.height / 2) * t.k).toBe(s.height / 2);
  });
  it("clips the viewport, even when the user has panned completely outside the islands", () => {
    const world = { width: 900, height: 600 };
    expect(
      viewportBounds(
        { x: -100, y: -50, k: 1 },
        { width: 200, height: 150 },
        world,
      ),
    ).toEqual({ x: 100, y: 50, width: 200, height: 150 });
    expect(
      viewportBounds(
        { x: 2000, y: 2000, k: 1 },
        { width: 200, height: 150 },
        world,
      ),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
  it("projects overview pointer coordinates including letterboxing and clamps outside the map", () => {
    const domain = overviewBounds({ width: 900, height: 3000 });
    expect(domain.width / domain.height).toBeCloseTo(170 / 110);
    const center = overviewPoint(
      { x: 85, y: 55 },
      { width: 170, height: 110 },
      domain,
      { width: 900, height: 3000 },
    );
    expect(center).toEqual({ x: 450, y: 1500 });
    expect(
      overviewPoint({ x: -100, y: 1000 }, { width: 170, height: 110 }, domain, {
        width: 900,
        height: 3000,
      }),
    ).toEqual({ x: 0, y: 3000 });
  });
});

describe("shared search and safe visible selection", () => {
  it("searches case-insensitively across aliases, URL, tags and group without editing the layout input", () => {
    const a = {
      name: "地图",
      alias: "Work",
      siteUrl: "https://Relay.example",
      group: "松岛",
      tags: ["常用"],
    };
    for (const q of [" WORK ", "relay", "松岛", "常用", ""])
      expect(matchesSearch(a, q)).toBe(true);
    expect(matchesSearch(a, "不存在")).toBe(false);
  });
  it("removes hidden selections and retains the same set when unchanged", () => {
    const selected = new Set(["a", "b"]);
    expect(retainVisibleSelection(selected, new Set(["a", "b", "c"]))).toBe(
      selected,
    );
    expect([...retainVisibleSelection(selected, new Set(["a"]))]).toEqual([
      "a",
    ]);
    expect(retainVisibleSelection(selected, new Set())).toEqual(new Set());
  });
  it("never submits more than 500 visible IDs", () => {
    const ids = new Set(accounts(501).map((a) => a.id));
    expect(retainVisibleSelection(ids, ids).size).toBe(500);
  });
});
