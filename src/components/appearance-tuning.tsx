"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type { Settings } from "@/lib/validation";
import { AtlasSelect } from "./atlas-select";
import "./appearance-tuning.css";

const colors = [
  { value: "theme", label: "跟随主题", color: null },
  { value: "blue", label: "海蓝", color: "#2A6F97" },
  { value: "green", label: "青绿", color: "#33836F" },
  { value: "amber", label: "琥珀", color: "#B57B24" },
  { value: "purple", label: "紫色", color: "#8062A8" },
  { value: "custom", label: "自定义", color: undefined },
] as const;

export function AppearanceTuning({ settings, busy, onSave }: {
  settings: Settings; busy: boolean; onSave: (value: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(settings); }, [settings]);
  const persist = (next: Settings) => {
    setDraft(next); setError("");
    void onSave(next).catch((e) => { setDraft(settings); setError(e instanceof Error ? e.message : "外观设置未保存"); });
  };
  const preset = colors.find((c) => c.color === (draft.inkColor || null))?.value || "custom";
  const commitRange = (field: "inkOpacity" | "mapOpacity") => {
    if ((draft[field] ?? 100) !== (settings[field] ?? 100)) persist(draft);
  };
  return <div className="appearance-tuning" data-testid="appearance-tuning">
    <div className="appearance-tuning-row">
      <div><strong>特效颜色</strong><small>墨迹和几何加载共用配色。</small></div>
      <AtlasSelect label="特效颜色" value={custom ? "custom" : preset} disabled={busy}
        options={colors.map(({ value, label }) => ({ value, label }))}
        onValueChange={(value) => {
          setCustom(value === "custom");
          if (value !== "custom") persist({ ...draft, inkColor: colors.find((c) => c.value === value)?.color ?? null });
        }} />
    </div>
    {(custom || preset === "custom") && <label className="appearance-tuning-row appearance-custom-color">
      <span>自定义特效颜色</span>
      <span><input aria-label="自定义特效颜色" type="color" value={draft.inkColor || "#2A6F97"} disabled={busy}
        onChange={(e) => persist({ ...draft, inkColor: e.target.value })} /> <output>{draft.inkColor || "#2A6F97"}</output></span>
    </label>}
    <label className="appearance-range-row"><span>特效浓度 <output>{draft.inkOpacity ?? 100}%</output></span>
      <input type="range" aria-label="特效浓度" min="0" max="100" step="1" value={draft.inkOpacity ?? 100} disabled={busy}
        onChange={(e) => setDraft({ ...draft, inkOpacity: Number(e.target.value) })}
        onPointerUp={() => commitRange("inkOpacity")} onKeyUp={() => commitRange("inkOpacity")} onBlur={() => commitRange("inkOpacity")} />
    </label>
    <div className="appearance-ink-preview" aria-label="特效配色预览" style={{ "--preview-color": draft.inkColor || "rgb(var(--ink-decoration))", "--preview-opacity": (draft.inkOpacity ?? 100) / 100 } as CSSProperties}>
      <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><small>{(draft.inkOpacity ?? 100) === 0 ? "特效已隐藏" : "配色预览"}</small>
    </div>
    <button className="button button-quiet appearance-reset" disabled={busy} onClick={() => {
      setCustom(false); persist({ ...draft, inkColor: null, inkOpacity: 100 });
    }}>恢复特效默认设置</button>
    <label className="appearance-range-row"><span>底图浓度 <output>{draft.mapOpacity ?? 100}%</output></span>
      <input type="range" aria-label="底图浓度" min="0" max="100" step="1" value={draft.mapOpacity ?? 100} disabled={busy}
        onChange={(e) => setDraft({ ...draft, mapOpacity: Number(e.target.value) })}
        onPointerUp={() => commitRange("mapOpacity")} onKeyUp={() => commitRange("mapOpacity")} onBlur={() => commitRange("mapOpacity")} />
    </label>
    <div className="appearance-tuning-row"><div><strong>底图密度</strong><small>调整纹理间距，保留地图文字清晰。</small></div>
      <AtlasSelect label="底图密度" value={draft.mapDensity || "standard"} disabled={busy}
        options={[{ value: "sparse", label: "疏朗" }, { value: "standard", label: "标准" }, { value: "dense", label: "细密" }]}
        onValueChange={(value) => persist({ ...draft, mapDensity: value as Settings["mapDensity"] })} />
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
