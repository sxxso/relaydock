import type { Camera } from "./map-management";
export type PatternKind =
  | "paper"
  | "dots"
  | "grid"
  | "cross"
  | "contours"
  | "sea";
export type PatternDensity = "sparse" | "standard" | "dense";
export function patternSpec(kind: PatternKind) {
  const width = kind === "contours" || kind === "sea"
    ? 480 : kind === "grid" ? 180 : kind === "cross" ? 48 : 32;
  const height = kind === "contours" || kind === "sea" ? 320 : width;
  const base = kind === "grid" ? 36 : kind === "cross" ? 48
    : kind === "contours" ? 40 : kind === "sea" ? 160 : 32;
  return {
    width, height, base,
    minimumSpacing: kind === "sea" ? 80 : kind === "contours" ? 32 : 24,
  };
}
export function backgroundPatternFrame(
  kind: PatternKind,
  density: PatternDensity,
  camera: Camera,
) {
  const spec = patternSpec(kind);
  const zoom = Number.isFinite(camera.k) && camera.k > 0 ? camera.k : 1;
  // Keep nested powers-of-two levels world anchored; density is an explicit
  // factor AFTER adaptive sampling, otherwise the sampling target cancels it.
  const multiplier = 2 ** Math.ceil(
    Math.log2(spec.minimumSpacing / (spec.base * zoom)),
  );
  const scale = zoom * multiplier * (
    density === "sparse" ? 2 : density === "dense" ? .5 : 1
  );
  // Equivalent tiled positions stay small even far into negative world space.
  const phase = (value: number, period: number) => Number.isFinite(value)
    ? ((value % period) + period) % period : 0;
  return {
    x: phase(camera.x, spec.width * scale),
    y: phase(camera.y, spec.height * scale),
    scale,
    screenSpacing: spec.base * scale,
  };
}
export function contourSegments(y: number, amplitude = 24) {
  return Array.from({ length: 4 }, (_, i) => {
    const x = i * 120, sign = i % 2 ? 1 : -1;
    return {
      start: { x, y },
      control1: { x: x + 40, y: y + sign * amplitude },
      control2: { x: x + 80, y: y + sign * amplitude },
      end: { x: x + 120, y },
    };
  });
}
export function contourPath(y: number, amplitude = 24) {
  return contourSegments(y, amplitude)
    .map((s, i) =>
      `${i === 0 ? `M${s.start.x} ${s.start.y} ` : ""}` +
      `C${s.control1.x} ${s.control1.y} ${s.control2.x} ${s.control2.y} ${s.end.x} ${s.end.y}`,
    ).join(" ");
}
