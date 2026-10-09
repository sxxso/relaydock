import { expect, it } from "vitest";
import * as colours from "../src/lib/group-colors";

it("automatically chooses readable foregrounds for the whole RGB space", () => {
  expect(colours).toHaveProperty("colorForeground");
  expect(colours).toHaveProperty("colorContrast");
  const { colorForeground, colorContrast } = colours;
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) {
    const color = "#" + [r,g,b].map((v) => v.toString(16).padStart(2, "0")).join("");
    expect(colorContrast(colorForeground(color), color), color).toBeGreaterThanOrEqual(4.5);
  }
});
it("shares safe styles across every representation and keeps defaults theme-driven", () => {
  expect(colours).toHaveProperty("groupColorStyle");
  const style = colours.groupColorStyle;
  expect(style("工作", [])).toBeUndefined();
  const value = style("工作", [{ name: "工作", color: "#FFFFFF" }]);
  expect(value).toHaveProperty("--group-mark", "#FFFFFF");
  expect(value).toHaveProperty("--group-on-mark", "#17253D");
  expect(JSON.stringify(value)).toContain("var(--surface)");
  expect(style("工作", [{ name: "工作", color: "var(--red)" }])).toBeUndefined();
});
it("returns a shared eight-colour print palette and theme-aware default node colours", () => {
  expect(colours).toHaveProperty("GROUP_COLOR_PRESETS");
  expect(colours).toHaveProperty("defaultGroupColor");
  const presets = colours.GROUP_COLOR_PRESETS;
  expect(presets).toHaveLength(8);
  expect(new Set(presets.map((p) => p.color)).size).toBe(8);
  for (const preset of presets) expect(colours.hexColorSchema.safeParse(preset.color).success).toBe(true);
  expect(colours.defaultGroupColor("常用", "light")).toBe("#DDB651");
  expect(colours.defaultGroupColor("常用", "dark")).toBe("#DFBC64");
});
