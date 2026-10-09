import { describe, expect, it } from "vitest";
import {
  backgroundPatternFrame,
  contourSegments,
  patternSpec,
} from "../src/lib/map-background-pattern";

describe("world-anchored map textures", () => {
  it.each(["dots", "grid", "cross", "contours", "sea"] as const)(
    "%s repeats without a phase jump when panning across negative tiles",
    (kind) => {
      const spec = patternSpec(kind);
      const a = backgroundPatternFrame(kind, "standard", { k: .63, x: -1301.5, y: -922.75 });
      const b = backgroundPatternFrame(kind, "standard", {
        k: .63,
        x: -1301.5 - spec.width * a.scale * 5,
        y: -922.75 + spec.height * a.scale * 3,
      });
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThan(spec.width * a.scale);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThan(spec.height * a.scale);
      expect(a.x).toBeCloseTo(b.x, 8);
      expect(a.y).toBeCloseTo(b.y, 8);
    },
  );
  it("changes texture spacing for each requested density at every zoom", () => {
    for (const kind of ["dots", "grid", "cross", "contours", "sea"] as const) {
      for (const k of [.00042, .02, .3, 1, 2.5]) {
        const frames = ["dense", "standard", "sparse"].map((density) =>
          backgroundPatternFrame(kind, density as "dense" | "standard" | "sparse", { x: 0, y: 0, k }),
        );
        expect(frames[0].screenSpacing).toBeCloseTo(frames[1].screenSpacing / 2);
        expect(frames[2].screenSpacing).toBeCloseTo(frames[1].screenSpacing * 2);
        expect(frames[0].screenSpacing).toBeGreaterThanOrEqual(12);
        expect(frames[1].screenSpacing).toBeGreaterThanOrEqual(patternSpec(kind).minimumSpacing);
        expect(frames[1].screenSpacing).toBeLessThan(patternSpec(kind).minimumSpacing * 2 + .0001);
      }
    }
  });
  it("keeps contour position and tangent continuous at the horizontal tile seam", () => {
    for (const y of [0, 40, 160, 320]) {
      const segments = contourSegments(y), first = segments[0], last = segments.at(-1)!;
      expect(first.start.y).toBe(last.end.y);
      expect(first.control1.y - first.start.y).toBe(last.end.y - last.control2.y);
      expect(first.control1.x - first.start.x).toBe(last.end.x - last.control2.x);
      const wrapped = contourSegments(y + patternSpec("contours").height);
      wrapped.forEach((segment, i) => {
        for (const key of ["start", "control1", "control2", "end"] as const) {
          expect(segment[key].y - segments[i][key].y).toBe(patternSpec("contours").height);
          expect(segment[key].x).toBe(segments[i][key].x);
        }
      });
    }
  });
  it("retains the previous default dot spacing and safely handles invalid camera scales", () => {
    expect(backgroundPatternFrame("dots", "standard", { k: 1, x: 0, y: 0 }).screenSpacing).toBe(32);
    for (const k of [0, -1, NaN, Infinity]) {
      expect(backgroundPatternFrame("sea", "standard", { k, x: 0, y: 0 }))
        .toEqual(backgroundPatternFrame("sea", "standard", { k: 1, x: 0, y: 0 }));
    }
  });
});
