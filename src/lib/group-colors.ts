import { z } from "zod";
import type { CSSProperties } from "react";
import { groupColorIndex } from "./map-layout";

export const hexColorSchema = z.string().trim()
  .regex(/^#[\da-f]{6}$/i, "请输入六位 HEX 色值，例如 #2D648C")
  .transform((color) => color.toUpperCase());
export const groupColorSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: hexColorSchema,
}).strict();
export const groupColorEntriesSchema = z.array(groupColorSchema).max(5000).refine(
  (entries) => new Set(entries.map((entry) => entry.name)).size === entries.length,
  "分组颜色重复",
);
export const groupColorsSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  colors: groupColorEntriesSchema,
}).strict();
export const groupColorInput = z.object({
  name: groupColorSchema.shape.name,
  color: hexColorSchema.nullable(),
  expectedRevision: groupColorsSchema.shape.revision,
}).strict();
export type GroupColor = z.infer<typeof groupColorSchema>;
export type GroupColors = z.infer<typeof groupColorsSchema>;

export const GROUP_COLOR_PRESETS = [
  { name: "青绿", color: "#3D6959" },
  { name: "赭黄", color: "#DDB651" },
  { name: "砖红", color: "#B74736" },
  { name: "海蓝", color: "#2D648C" },
  { name: "群青", color: "#424D8C" },
  { name: "陶土", color: "#9E735A" },
  { name: "梅紫", color: "#754A80" },
  { name: "石墨", color: "#4D5965" },
] as const;
const DARK_DEFAULTS = ["#8CBCA4", "#DFBC64", "#D98977", "#8BB9D6"];
export function defaultGroupColor(name: string, theme: "light" | "dark") {
  const index = groupColorIndex(name);
  return theme === "dark" ? DARK_DEFAULTS[index] : GROUP_COLOR_PRESETS[index].color;
}
function luminance(hex: string) {
  const channels = hexColorSchema.parse(hex).slice(1).match(/../g)!.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
export function colorContrast(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Keep the print ink where readable; black covers the small mid-tone gap. */
export function colorForeground(color: string) {
  if (colorContrast("#17253D", color) >= 4.5) return "#17253D";
  if (colorContrast("#FFFFFF", color) >= 4.5) return "#FFFFFF";
  return "#000000";
}
/** CSS variables work identically on SVG groups, avatars and previews. */
export function groupColorStyle(name: string, colors: readonly GroupColor[]): CSSProperties | undefined {
  const candidate = colors.find((entry) => entry.name === (name || "未分组"));
  const parsed = hexColorSchema.safeParse(candidate?.color);
  if (!parsed.success) return undefined;
  return {
    "--group-mark": parsed.data,
    "--group-on-mark": colorForeground(parsed.data),
    "--group-wash": `color-mix(in srgb, ${parsed.data} 18%, var(--surface))`,
  } as CSSProperties;
}
