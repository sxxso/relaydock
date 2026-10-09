"use client";
import { useId, useState } from "react";
import { PenLine } from "lucide-react";
import { AtlasSelect } from "./atlas-select";
import { Modal } from "./modal";
export function GroupRename({
  name,
  groups,
  count,
  onClose,
  onSave,
}: {
  name: string;
  groups: string[];
  count: (name: string) => number;
  onClose: () => void;
  onSave: (name: string, newName: string) => Promise<void>;
}) {
  const [source, setSource] = useState(name),
    [newName, setNewName] = useState(name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inputId = useId();
  return (
    <Modal
      open
      title="分组改名"
      description="组内所有账号（含归档）同步改名。位置、余额、历史及凭据保持不变。"
      onClose={onClose}
      closeDisabled={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const next = newName.trim();
          if (!next || next.length > 50) {
            setError("分组名须为 1–50 个字符");
            return;
          }
          if (next !== source && groups.includes(next)) {
            setError("该分组已存在，不会自动合并。请换一个名字。");
            return;
          }
          setBusy(true);
          setError("");
          try {
            await onSave(source, next);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <AtlasSelect
            label="需要改名的分组"
            value={source}
            disabled={busy}
            options={groups.map((g) => ({
              value: g,
              label: g,
              description: `${count(g)} 个账号 · 含归档`,
            }))}
            onValueChange={(v) => {
              setSource(v);
              setNewName(v);
              setError("");
            }}
          />
        </div>
        <label className="field" htmlFor={inputId}>
          <span>新的分组名称</span>
          <input
            id={inputId}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={50}
            autoComplete="off"
            autoFocus
            disabled={busy}
            required
          />
        </label>
        <p className="body-note">
          将更新 {count(source)} 个账号；重名不会合并分组。
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            <PenLine size={15} />
            {busy ? "正在保存" : "保存分组名称"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
