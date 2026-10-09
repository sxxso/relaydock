import type { Settings } from "@/lib/validation";
import { contourPath, type PatternKind } from "@/lib/map-background-pattern";
export type MapBackground = NonNullable<Settings["mapBackground"]>;
export const backgroundOptions: {
  value: MapBackground;
  label: string;
  description: string;
}[] = [
  { value: "paper", label: "素纸", description: "只留纸纹，让群岛安静展开" },
  {
    value: "dots",
    label: "点阵",
    description: "轻点定位，接近知识图谱的工作感",
  },
  { value: "grid", label: "方格", description: "细网格与主刻度，像一张测绘纸" },
  {
    value: "cross",
    label: "十字坐标",
    description: "疏朗的交叉标记，保留更多留白",
  },
  {
    value: "contours",
    label: "等高线",
    description: "原创地形线，延续群岛的地图语汇",
  },
  {
    value: "sea",
    label: "疏朗海图",
    description: "淡坐标与海流曲线，给群岛留出呼吸空间",
  },
];
export function BackgroundGlyph({ kind }: { kind: MapBackground }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x=".5"
        y=".5"
        width="19"
        height="19"
        rx="4"
        stroke="currentColor"
        opacity=".25"
      />
      {kind === "paper" && (
        <path d="M4 14L9 6L16 12" stroke="currentColor" opacity=".55" />
      )}
      {kind === "dots" &&
        [5, 10, 15].flatMap((x) =>
          [5, 10, 15].map((y) => (
            <circle
              key={x + "," + y}
              cx={x}
              cy={y}
              r=".8"
              fill="currentColor"
            />
          )),
        )}
      {kind === "grid" && (
        <path
          d="M5 2v16M10 2v16M15 2v16M2 5h16M2 10h16M2 15h16"
          stroke="currentColor"
          strokeWidth=".5"
        />
      )}
      {kind === "cross" && (
        <path
          d="M6 3v6M3 6h6M14 11v6M11 14h6"
          stroke="currentColor"
          strokeWidth=".8"
        />
      )}
      {kind === "contours" && (
        <path
          d="M2 7Q7 2 12 7T18 7M2 11Q7 6 12 11T18 11M2 15Q7 10 12 15T18 15"
          stroke="currentColor"
          strokeWidth=".7"
        />
      )}
      {kind === "sea" && (
        <path
          d="M5 3v4M3 5h4M15 12v4M13 14h4M2 10Q6 6 10 10T18 10"
          stroke="currentColor"
          strokeWidth=".7"
        />
      )}
    </svg>
  );
}

/** Static geometry only; camera sampling updates its parent SVG pattern. */
export function BackgroundPattern({ kind }: { kind: PatternKind }) {
  return <g className="map-pattern-lines" fill="none" stroke="currentColor" strokeWidth=".7">
    {kind === "dots" && <circle cx="16" cy="16" r="1.1" fill="currentColor" stroke="none" />}
    {kind === "grid" && <>
      <path d="M36 0v180M72 0v180M108 0v180M144 0v180M0 36h180M0 72h180M0 108h180M0 144h180" opacity=".38" />
      <path d="M0 180V0h180" strokeWidth="1" opacity=".8" />
      <path d="M0 6V0h6M174 0h6v6" strokeWidth="1.1" />
    </>}
    {kind === "cross" && <path d="M24 20v8M20 24h8" strokeWidth=".8" />}
    {kind === "contours" && Array.from({ length: 9 }, (_, i) => (
      <path key={i} d={contourPath(i * 40)} opacity={i % 4 === 0 ? ".8" : ".42"} strokeWidth={i % 4 === 0 ? "1.1" : ".7"} />
    ))}
    {kind === "sea" && <>
      {[80, 240, 400].flatMap((x) => [56, 216].map((y) => (
        <path key={`${x}-${y}`} d={`M${x} ${y - 4}v8M${x - 4} ${y}h8`} strokeWidth=".8" opacity=".85" />
      )))}
      <path d={contourPath(112, 17)} strokeWidth=".8" opacity=".48" />
      <path d={contourPath(272, 11)} strokeWidth=".7" opacity=".32" />
    </>}
  </g>;
}
