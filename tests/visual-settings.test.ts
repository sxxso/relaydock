import { describe, expect, it } from "vitest";
import { settingsSchema } from "../src/lib/validation";

describe("appearance settings preserve legacy input and validate decoration separately", () => {
  it("fills legacy settings with visual defaults", () => {
    expect(settingsSchema.parse({ theme: "dark", motion: false })).toMatchObject({
      inkColor: null, inkOpacity: 100, inkStyle: "wake", mapOpacity: 100, mapDensity: "standard", mapBackground: "dots",
    });
  });
  it("accepts a custom RGB color, zero opacity, sea and sparse texture", () => {
    expect(settingsSchema.parse({ inkColor: "#2a6f97", inkOpacity: 0, mapOpacity: 30, mapBackground: "sea", mapDensity: "sparse" })).toMatchObject({ inkColor: "#2a6f97", inkOpacity: 0, mapDensity: "sparse" });
  });
  it.each(["wake", "stardust", "orbit"])("preserves %s through a settings JSON round trip", (inkStyle) => {
    const saved = settingsSchema.parse({ theme: "dark", motion: false, inkStyle });
    expect(settingsSchema.parse(JSON.parse(JSON.stringify(saved)))).toMatchObject({ theme: "dark", motion: false, inkStyle });
  });
  it.each([{ inkStyle: "unknown" }, { inkColor: "red" }, { inkColor: "#fff" }, { inkColor: "url(x)" }, { inkOpacity: 101 }, { inkOpacity: -1 }, { inkOpacity: 20.1 }, { mapOpacity: NaN }, { mapDensity: "busy" }])("rejects invalid settings %j", (input) => {
    expect(settingsSchema.safeParse(input).success).toBe(false);
  });
});
