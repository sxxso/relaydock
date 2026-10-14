import { describe, expect, it } from "vitest";
import { islandPath, layoutIslands } from "../src/lib/map-layout";

describe("island coast geometry", () => {
  it("keeps coast coordinates finite and inside drag bounds at all group sizes", () => {
    for (const count of [1, 2, 16, 200, 500]) {
      const { islands } = layoutIslands(Array.from({ length: count }, (_, n) => ({ id: String(n), group: "海岸" })), [{ name: "海岸", x: -500, y: -280 }]);
      const island = islands[0], path = islandPath(island);
      expect(path.endsWith(" Z")).toBe(true);
      const values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      for (let n = 0; n < values.length; n += 2) {
        expect(values[n]).toBeGreaterThanOrEqual(island.x);
        expect(values[n]).toBeLessThanOrEqual(island.x + island.width);
        expect(values[n + 1]).toBeGreaterThanOrEqual(island.y);
        expect(values[n + 1]).toBeLessThanOrEqual(island.y + island.height);
      }
      expect(islandPath({ ...island })).toBe(path);
      expect(islandPath({ ...island, seed: island.seed + 73 })).not.toBe(path);
    }
  });
});
