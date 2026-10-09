import { describe, expect, it } from "vitest";
import {
  computeFilterMenuPosition,
  type FilterMenuPositionInput,
} from "../src/lib/filter-menu-position";

const base: FilterMenuPositionInput = {
  anchor: { left: 500, right: 536, top: 90, bottom: 126 },
  viewport: { width: 1024, height: 768 },
  panelHeight: 360,
};

describe("more filters viewport placement", () => {
  it("right-aligns below the actual anchor when the whole panel fits", () => {
    expect(computeFilterMenuPosition(base)).toEqual({
      left: 306, top: 134, width: 230, maxHeight: 622, side: "bottom",
    });
  });

  it("prefers below when both sides fit, even if above is larger", () => {
    const result = computeFilterMenuPosition({
      ...base,
      anchor: { left: 500, right: 536, top: 500, bottom: 536 },
      viewport: { width: 1024, height: 900 },
      panelHeight: 240,
    });
    expect(result.side).toBe("bottom");
    expect(result.top).toBe(544);
  });

  it("flips above when below clips and above fits", () => {
    expect(computeFilterMenuPosition({
      ...base,
      anchor: { left: 500, right: 536, top: 280, bottom: 316 },
      viewport: { width: 1024, height: 400 },
      panelHeight: 220,
    })).toEqual({ left: 306, top: 52, width: 230, maxHeight: 260, side: "top" });
  });

  it("chooses the larger upper region and makes a tall panel scrollable", () => {
    expect(computeFilterMenuPosition({
      ...base,
      anchor: { left: 500, right: 536, top: 130, bottom: 166 },
      viewport: { width: 1024, height: 240 },
      panelHeight: 390,
    })).toEqual({ left: 306, top: 12, width: 230, maxHeight: 110, side: "top" });
  });

  it("chooses the larger lower region when neither side fits", () => {
    const result = computeFilterMenuPosition({
      ...base,
      anchor: { left: 500, right: 536, top: 50, bottom: 86 },
      viewport: { width: 1024, height: 240 },
      panelHeight: 390,
    });
    expect(result).toMatchObject({ top: 94, maxHeight: 134, side: "bottom" });
  });

  it("keeps a tall menu inside the proven 768x360 landscape viewport", () => {
    const result = computeFilterMenuPosition({
      ...base,
      anchor: { left: 640, right: 676, top: 0, bottom: 36 },
      viewport: { width: 768, height: 360 },
    });
    expect(result).toMatchObject({ top: 44, maxHeight: 304, side: "bottom" });
    expect(result.top + Math.min(base.panelHeight, result.maxHeight)).toBe(348);
    expect(result.maxHeight).toBeLessThan(base.panelHeight);
  });

  it("keeps below as the stable tie-break when both sides need scrolling", () => {
    expect(computeFilterMenuPosition({
      ...base,
      anchor: { left: 500, right: 536, top: 132, bottom: 168 },
      viewport: { width: 1024, height: 300 },
    })).toMatchObject({ top: 176, maxHeight: 112, side: "bottom" });
  });

  it("shrinks the width to leave both safe margins on a narrow viewport", () => {
    expect(computeFilterMenuPosition({
      ...base,
      anchor: { left: 134, right: 170, top: 24, bottom: 60 },
      viewport: { width: 180, height: 500 },
    })).toEqual({ left: 12, top: 68, width: 156, maxHeight: 420, side: "bottom" });
  });

  it.each([
    { left: -16, right: 20, expected: 12 },
    { left: 300, right: 336, expected: 78 },
  ])("clamps horizontal edges for an anchor at $left", ({ left, right, expected }) => {
    expect(computeFilterMenuPosition({
      ...base,
      anchor: { left, right, top: 24, bottom: 60 },
      viewport: { width: 320, height: 500 },
    }).left).toBe(expected);
  });

  it("uses visual viewport offsets for keyboard/pinch-zoom visibility", () => {
    expect(computeFilterMenuPosition({
      ...base,
      anchor: { left: 260, right: 296, top: 220, bottom: 256 },
      viewport: { width: 280, height: 240, offsetLeft: 40, offsetTop: 80 },
      panelHeight: 310,
    })).toEqual({ left: 66, top: 92, width: 230, maxHeight: 120, side: "top" });
  });

  it("honors explicit spacing and preferred width", () => {
    expect(computeFilterMenuPosition({
      ...base,
      anchor: { left: 14, right: 50, top: 90, bottom: 126 },
      viewport: { width: 320, height: 300 },
      panelHeight: 140,
      panelWidth: 280,
      margin: 16,
      gap: 4,
    })).toEqual({ left: 16, top: 130, width: 280, maxHeight: 154, side: "bottom" });
  });

  it.each([
    { top: -60, bottom: -24, expectedTop: 12, side: "bottom" },
    { top: 620, bottom: 656, expectedTop: 12, side: "top" },
  ])("keeps the panel in view after its anchor scrolls to $top", ({ top, bottom, expectedTop, side }) => {
    const result = computeFilterMenuPosition({
      ...base,
      anchor: { left: 500, right: 536, top, bottom },
      viewport: { width: 1024, height: 400 },
      panelHeight: 500,
    });
    expect(result).toMatchObject({ top: expectedTop, maxHeight: 376, side });
  });

  it("does not emit negative dimensions when the viewport is smaller than its margins", () => {
    expect(computeFilterMenuPosition({
      ...base,
      viewport: { width: 16, height: 14 },
    })).toEqual({ left: 8, top: 7, width: 0, maxHeight: 0, side: "bottom" });
  });
});
