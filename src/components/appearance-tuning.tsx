"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type { Settings } from "@/lib/validation";
import { AtlasSelect } from "./atlas-select";
import { InkCanvas } from "./ink-canvas";
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
    <div className="effect-studio-heading"><div><strong>指尖航迹</strong><small>让每次经过，都留下一点小惊喜。</small></div><span>动效试验台</span></div>
    <div className="effect-choices" role="group" aria-label="航迹样式">
      {([['wake','潮汐水纹','一笔漾开，慢慢消散'],['stardust','金砂星屑','细碎星光，跟随指尖'],['orbit','环绕星轨','轻盈弧线，绕出涟漪']] as const).map(([value,label,description])=><button key={value} disabled={busy} aria-pressed={(draft.inkStyle || 'wake')===value} onClick={()=>persist({...draft,inkStyle:value})}>
        <svg viewBox="0 0 160 64" aria-hidden="true">{value==='wake' ? <g fill="none" stroke="currentColor"><path d="M5 33Q35 9 70 33T150 33M5 42Q35 18 70 42T150 42M5 51Q35 27 70 51T150 51"/></g> : value==='stardust' ? <g fill="currentColor"><path d="m75 9 4 17 16 5-16 5-4 17-5-17-16-5 16-5Z"/><path d="m117 27 2 9 9 3-9 3-2 9-3-9-9-3 9-3ZM36 13l2 6 7 2-7 2-2 7-2-7-7-2 7-2Z"/></g> : <g fill="none" stroke="currentColor"><ellipse cx="80" cy="33" rx="47" ry="16" transform="rotate(-18 80 33)"/><ellipse cx="80" cy="33" rx="33" ry="23" transform="rotate(24 80 33)"/><circle cx="123" cy="17" r="4" fill="currentColor"/></g>}</svg>
        <strong>{label}</strong><small>{description}</small>
      </button>)}
    </div>
    <div className="appearance-ink-preview" aria-label="特效配色预览" style={{ "--preview-color": draft.inkColor || "rgb(var(--ink-decoration))", "--preview-opacity": (draft.inkOpacity ?? 100) / 100 } as CSSProperties}>
      <div className="effect-preview-rings" aria-hidden="true"><i/><i/><i/></div>
      <InkCanvas enabled={draft.motion} color={draft.inkColor} opacity={draft.inkOpacity} variant={draft.inkStyle}/>
      <div className="effect-preview-label"><strong>在这里划过，试试手感</strong><small>{!draft.motion ? '装饰动效已关闭' : (draft.inkOpacity ?? 100) === 0 ? '特效已隐藏' : '移动鼠标试绘 · 停下后自然消散'}</small></div>
    </div>
    <div className="appearance-tuning-row">
      <div><strong>特效颜色</strong><small>航迹与几何加载共用配色。</small></div>
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
    <button className="button button-quiet appearance-reset" disabled={busy} onClick={() => {
      setCustom(false); persist({ ...draft, inkColor: null, inkOpacity: 100, inkStyle: "wake" });
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
