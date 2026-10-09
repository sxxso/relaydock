"use client";
import { useId, useState } from "react";
import { Check, Palette, RotateCcw } from "lucide-react";
import {
  GROUP_COLOR_PRESETS, colorForeground, defaultGroupColor, groupColorStyle,
  hexColorSchema, type GroupColors,
} from "@/lib/group-colors";
import { AtlasSelect } from "./atlas-select";
import { Modal } from "./modal";
import styles from "./group-color-editor.module.css";

export function GroupColorEditor({ name, groups, model, theme, sampleName, count, onClose, onSave }: {
  name: string;
  groups: string[];
  model: GroupColors;
  theme: "light" | "dark";
  sampleName: (group: string) => string;
  count: (group: string) => number;
  onClose: () => void;
  onSave: (name: string, color: string | null, revision: number) => Promise<void>;
}) {
  const original = (group: string) => model.colors.find((entry) => entry.name === group)?.color ?? null;
  const [source, setSource] = useState(name);
  const [draft, setDraft] = useState<string | null>(() => original(name));
  const [revision, setRevision] = useState(model.revision);
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const id = useId(), hintId = `${id}-hint`;
  const parsed = hexColorSchema.safeParse(draft ?? defaultGroupColor(source, theme));
  const color = parsed.success ? parsed.data : original(source) ?? defaultGroupColor(source, theme);
  const value = draft === null ? null : parsed.success ? parsed.data : undefined;
  const dirty = value !== original(source);
  const previewStyle = groupColorStyle(source, [{ name: source, color }]);
  const label = sampleName(source), initial = Array.from(label)[0] || "站";
  return (
    <Modal open wide title="分组颜色" description="给每组站点一个自己的颜色。地图、列表和定位小窗会同步更新。" onClose={onClose} closeDisabled={busy}>
      <form className={styles.editor} onSubmit={async (event) => {
        event.preventDefault();
        if (busy || value === undefined || !dirty || (conflicted && model.revision <= revision)) return;
        setBusy(true); setError("");
        try { await onSave(source, value, conflicted ? model.revision : revision); onClose(); }
        catch (e) {
          const problem = e as Error & { status?: number };
          setConflicted(problem.status === 409);
          setError(problem.message);
        } finally { setBusy(false); }
      }}>
        <div className={styles.controls}>
          <div className="field">
            <span id={`${id}-group`}>颜色所属分组</span>
            <AtlasSelect label="颜色所属分组" value={source} disabled={busy} options={groups.map((group) => ({ value: group, label: group }))}
              onValueChange={(group) => { setSource(group); setDraft(original(group)); setRevision(model.revision); setConflicted(false); setError(""); }} />
          </div>
          <fieldset className={styles.palette} disabled={busy}>
            <legend>印刷色预设</legend>
            <div className={styles.swatches}>
              {GROUP_COLOR_PRESETS.map((preset) => (
                <button key={preset.color} type="button" className={styles.swatch} aria-label={preset.name} title={`${preset.name} ${preset.color}`}
                  aria-pressed={draft !== null && color === preset.color}
                  onClick={() => { setDraft(preset.color); setError(""); }}>
                  <span className={styles.ink} style={{ background: preset.color, color: colorForeground(preset.color) }}>
                    {draft !== null && color === preset.color && <Check size={20} strokeWidth={2.5} />}
                  </span>
                  <span>{preset.name}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className={styles.custom}>
            <label className={styles.picker}>
              <span>自由取色</span>
              <input type="color" aria-label="自由取色" value={color} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError(""); }} />
            </label>
            <label className="field" htmlFor={id}>
              <span>HEX 色值</span>
              <input id={id} value={draft ?? color} disabled={busy} autoComplete="off" spellCheck={false}
                aria-describedby={hintId} aria-invalid={!parsed.success}
                onChange={(event) => { setDraft(event.target.value); setError(""); }} />
            </label>
          </div>
          <p id={hintId} className={styles.hint}>
            {!parsed.success ? "请输入六位 HEX 色值，例如 #2D648C。" : draft === null ? "正在预览默认配色，会随浅深主题调整。" : "文字自动调整深浅；余额警示保持独立。"}
          </p>
          <button type="button" className={styles.reset} disabled={busy || draft === null} onClick={() => { setDraft(null); setError(""); }}>
            <RotateCcw size={14} />恢复默认
          </button>
        </div>
        <div className={styles.preview} style={previewStyle}>
          <div className={styles.previewHeading}><strong>{source}</strong><span>{count(source)} 个站点 · 含归档</span></div>
          <svg key={`${source}:${color}`} className={styles.composition} viewBox="0 0 280 210" role="img" aria-label="地图节点配色预览">
            <rect className={styles.previewWash} x="18" y="20" width="224" height="165" />
            <rect className={styles.previewSquare} x="193" y="35" width="42" height="42" />
            <path className={styles.previewRule} d="M34 178H250" />
            <circle className={styles.previewHalo} cx="117" cy="92" r="42" />
            <circle className={styles.previewNode} cx="117" cy="92" r="32" data-testid="color-preview-node" />
            <text className={styles.previewInitial} x="117" y="100" textAnchor="middle" data-testid="color-preview-initial">{initial}</text>
            <text className={styles.previewName} x="117" y="155" textAnchor="middle">{label.length > 18 ? label.slice(0, 17) + "…" : label}</text>
          </svg>
          <div className={styles.previewRow}>
            <span className={styles.avatar}>{initial}</span><span><strong>{label}</strong><small>{source}</small></span>
          </div>
          <p className={styles.previewNote}>地图节点与列表头像预览<br />保存后应用，取消不会改变工作台。</p>
        </div>
        {error && <p className={"form-error " + styles.error} role="alert">{error}</p>}
        <div className={"modal-actions " + styles.actions}>
          <button type="button" className="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !parsed.success || !dirty || (conflicted && model.revision <= revision)}><Palette size={15} />{busy ? "正在保存" : "保存颜色"}</button>
        </div>
      </form>
    </Modal>
  );
}
