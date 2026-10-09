"use client";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  CheckSquare,
  FolderInput,
  LoaderCircle,
  Tags,
  X,
} from "lucide-react";
import type { Account } from "@/lib/validation";
import type { Send } from "./account-form";
import { AtlasSelect } from "./atlas-select";
import { Modal } from "./modal";
import { makeUndoEntry, sameStringArray, type UndoEntry } from "@/lib/undo";
import "./batch-management.css";

export function SelectionBox({
  label,
  checked,
  mixed = false,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="batch-checkbox" title={label}>
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span aria-hidden="true">{mixed ? <i /> : <Check size={12} />}</span>
    </label>
  );
}

export function BatchManagement({
  accounts,
  groups,
  enabled,
  onEnabledChange,
  selection,
  onSelectionChange,
  send,
  onSaved,
  notify,
  onDialogOpenChange,
  onConflict,
}: {
  accounts: Account[];
  groups: string[];
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  selection: ReadonlySet<string>;
  onSelectionChange: (value: ReadonlySet<string>) => void;
  send: Send;
  onSaved: (accounts: Account[], undo?: { message: string; entries: UndoEntry[] }) => void;
  notify: (message: string) => void;
  onDialogOpenChange?: (open: boolean) => void;
  onConflict?: () => void;
}) {
  const [action, setAction] = useState<"group" | "tags" | "archive" | null>(
      null,
    ),
    [targets, setTargets] = useState<Account[]>([]),
    [group, setGroup] = useState(""),
    [tags, setTags] = useState(""),
    [tagMode, setTagMode] = useState("add"),
    [archive, setArchive] = useState(true),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState("");
  const submittingRef = useRef(false);
  useEffect(() => { onDialogOpenChange?.(action !== null); }, [action, onDialogOpenChange]);
  const visibleSelected = accounts.filter((a) => selection.has(a.id));
  const currentIds = new Set(visibleSelected.map((a) => a.id));
  const scopeCurrent =
    targets.length > 0 &&
    targets.length === currentIds.size &&
    targets.every((a) => currentIds.has(a.id) && visibleSelected.find((current) => current.id === a.id)?.updatedAt === a.updatedAt);
  function open(kind: NonNullable<typeof action>, archived = true) {
    if (!visibleSelected.length) return;
    setTargets(visibleSelected);
    setAction(kind);
    setArchive(archived);
    setGroup("");
    setTags("");
    setTagMode("add");
    setError("");
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    // Responses arriving behind the modal can change the shared result set.
    // Never submit the frozen targets after they leave the current selection.
    if (submittingRef.current || !scopeCurrent || !action) return;
    const parsedTags = [
      ...new Set(
        tags
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (action === "group" && (!group.trim() || group.trim().length > 50)) {
      setError("请输入 1–50 字的目标分组");
      return;
    }
    if (
      action === "tags" &&
      (parsedTags.length > 12 ||
        parsedTags.some((t) => t.length > 24) ||
        (!parsedTags.length && tagMode !== "replace"))
    ) {
      setError("标签最多 12 个，每个 1–24 字；添加或移除时至少填写一个标签");
      return;
    }
    const operation =
      action === "group"
        ? { kind: "group", group: group.trim() }
        : action === "tags"
          ? { kind: "tags", mode: tagMode, tags: parsedTags }
          : { kind: "archive", archived: archive };
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const result = await send<{ accounts: Account[] }>(
        "accounts/batch",
        "POST",
        { ids: targets.map((a) => a.id), operation, expectedUpdatedAt: Object.fromEntries(targets.map((a) => [a.id, a.updatedAt])) },
      );
      const entries = targets.flatMap((before, index) => {
        const after = result.accounts[index];
        if (!after) return [];
        if (action === "group" && before.group === after.group) return [];
        if (action === "archive" && before.archived === after.archived) return [];
        if (action === "tags" && sameStringArray(before.tags, after.tags)) return [];
        const restore =
          action === "group"
            ? { group: before.group }
            : action === "tags"
              ? { tags: [...before.tags] }
              : { archived: before.archived };
        const entry = makeUndoEntry(before.id, after.updatedAt, restore);
        return entry ? [entry] : [];
      });
      onSaved(result.accounts, {
        message: `已${action === "group" ? "修改分组" : action === "tags" ? "更新标签" : archive ? "归档" : "取消归档"}：${result.accounts.length} 个账号。余额与查询凭据未改变`,
        entries,
      });
      onSelectionChange(new Set());
      setAction(null);
    } catch (e) {
      setError((e as Error).message);
      if ((e as Error & { status?: number }).status === 409) onConflict?.();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  const title =
    action === "group"
      ? "批量修改分组"
      : action === "tags"
        ? "批量编辑标签"
        : archive
          ? "归档所选账号"
          : "取消归档所选账号";
  return (
    <>
      <div className={`batch-toolbar ${enabled ? "is-open" : ""}`}>
        <button
          className="button batch-enter"
          aria-label={enabled ? "退出批量管理" : "批量管理"}
          onClick={() => {
            onEnabledChange(!enabled);
            if (enabled) onSelectionChange(new Set());
          }}
        >
          {enabled ? <X size={14} /> : <CheckSquare size={14} />}
          {enabled ? "退出批量管理" : "批量管理"}
        </button>
        {enabled ? (
          <>
            <span className="batch-count" role="status">
              已选 {visibleSelected.length} 个
            </span>
            <div className="batch-actions">
              <button
                disabled={!visibleSelected.length}
                onClick={() => open("group")}
              >
                <FolderInput size={14} />
                修改分组
              </button>
              <button
                disabled={!visibleSelected.length}
                onClick={() => open("tags")}
              >
                <Tags size={14} />
                编辑标签
              </button>
              <button
                disabled={!visibleSelected.length}
                onClick={() => open("archive", true)}
              >
                <Archive size={14} />
                归档所选
              </button>
              {visibleSelected.some((a) => a.archived) && (
                <button
                  disabled={!visibleSelected.length}
                  onClick={() => open("archive", false)}
                >
                  取消归档所选
                </button>
              )}
              <button
                disabled={!visibleSelected.length}
                onClick={() => onSelectionChange(new Set())}
              >
                清空选择
              </button>
            </div>
            <small className="batch-scope">
              只操作当前结果中勾选的账号。
              {accounts.length > 500
                ? "全选仅取前 500 个；每批最多 500 个。"
                : "改变筛选会移除隐藏项。"}
            </small>
          </>
        ) : (
          <span className="batch-hint">一起整理分组、标签与归档</span>
        )}
      </div>
      <Modal
        open={action !== null}
        onClose={() => {
          if (!submittingRef.current) setAction(null);
        }}
        title={title}
        description={`仅修改已选 ${targets.length} 个账号的${action === "group" ? "分组" : action === "tags" ? "标签" : "归档状态"}；不查询、不修改余额或凭据。`}
        closeDisabled={submitting}
      >
        <form onSubmit={save} className="batch-form">
          <div className="batch-targets">
            <strong>操作范围 · {targets.length} 个账号</strong>
            <p>
              {targets
                .slice(0, 5)
                .map((a) => a.name + (a.alias ? ` (${a.alias})` : ""))
                .join("、")}
              {targets.length > 5 ? `，另 ${targets.length - 5} 个` : ""}
            </p>
          </div>
          {!scopeCurrent && (
            <div className="batch-warning" role="alert">
              <p>
                操作范围已变化，尚未提交。请重新确认当前{" "}
                {visibleSelected.length} 个账号，或取消后重新选择。
              </p>
              <button
                type="button"
                className="button"
                disabled={submitting || !visibleSelected.length}
                onClick={() => {
                  setTargets(visibleSelected);
                  setError("");
                }}
              >
                重新确认当前范围
              </button>
            </div>
          )}
          {action === "group" && (
            <>
              <label className="field">
                <span>已有分组</span>
                <AtlasSelect
                  label="已有分组"
                  value={groups.includes(group) ? `group:${group}` : "new"}
                  disabled={submitting}
                  onValueChange={(v) => setGroup(v === "new" ? "" : v.slice(6))}
                  options={[
                    {
                      value: "new",
                      label: "输入新分组",
                      description: "也可以选择已有群岛",
                    },
                    ...groups.map((g) => ({
                      value: `group:${g}`,
                      label: g,
                      icon: <FolderInput size={14} />,
                    })),
                  ]}
                />
              </label>
              <label className="field">
                <span>目标分组</span>
                <input
                  aria-label="目标分组"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  maxLength={50}
                  required
                  disabled={submitting}
                  placeholder="例如：工作常用"
                />
              </label>
              <p className="field-hint">
                改分组会重新排列受影响群岛；余额与历史仍跟随原账号。
              </p>
            </>
          )}
          {action === "tags" && (
            <>
              <label className="field">
                <span>标签操作</span>
                <AtlasSelect
                  label="标签操作"
                  value={tagMode}
                  onValueChange={setTagMode}
                  disabled={submitting}
                  options={[
                    {
                      value: "add",
                      label: "添加标签",
                      description: "保留已有标签，自动去重",
                      icon: <Tags size={15} />,
                    },
                    {
                      value: "remove",
                      label: "移除标签",
                      description: "只移除填写的标签",
                    },
                    {
                      value: "replace",
                      label: "替换全部标签",
                      description: "覆盖原标签；留空表示清空",
                      icon: <FolderInput size={15} />,
                    },
                  ]}
                />
              </label>
              <label className="field">
                <span>标签（逗号分隔）</span>
                <input
                  aria-label="标签（逗号分隔）"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  disabled={submitting}
                  placeholder="常用, 工作"
                  maxLength={600}
                />
              </label>
              <p
                className={
                  tagMode === "replace" ? "batch-warning" : "field-hint"
                }
              >
                {tagMode === "replace"
                  ? "此操作将覆盖每个已选账号的全部原标签；留空后点击应用，会清空原标签。"
                  : "每个账号最多 12 个标签。如果合并后超限，整批不保存，请先移除旧标签。"}
              </p>
            </>
          )}
          {action === "archive" && (
            <p className="batch-warning">
              {archive
                ? "归档后将从使用中的地图与列表隐藏，历史、余额与凭据保留。可在「已归档账号」中取消归档。"
                : "取消归档后重新显示在使用中的地图与列表。不查询余额。"}
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error} · 未确认保存，所选账号保留；请核对后重试。
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="button"
              disabled={submitting}
              onClick={() => setAction(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={submitting || !scopeCurrent}
            >
              {submitting && <LoaderCircle size={15} className="spin" />}
              {submitting
                ? "保存中…"
                : action === "group"
                  ? "保存分组"
                  : action === "tags"
                    ? "应用标签"
                    : archive
                      ? "确认归档"
                      : "确认取消归档"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
