"use client";
import { LoaderCircle, Undo2, X } from "lucide-react";
import { useEffect } from "react";
import type { PendingUndo, PendingUndoAction } from "@/lib/pending-undo";
export function UndoNotice({ action, controller, onUndo }: { action: PendingUndoAction; controller: PendingUndo; onUndo: () => void }) {
  useEffect(() => () => { controller.pause("pointer", false); controller.pause("focus", false); }, [controller]);
  return <div className="toast undo-notice" role="status"
    onPointerEnter={() => controller.pause("pointer", true)} onPointerLeave={() => controller.pause("pointer", false)}
    onFocusCapture={() => controller.pause("focus", true)} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) controller.pause("focus", false);
    }}>
    <Undo2 size={16} aria-hidden="true" />
    <div className="undo-notice-copy"><strong>{action.message}</strong>
      {action.error && <span className="undo-notice-error">{action.error}</span>}
      <small aria-hidden="true">{action.busy ? "正在撤销，请稍候" : `${action.seconds} 秒内可撤销 · 停留或聚焦暂停倒计时`}</small>
    </div>
    <button className="toast-undo" onClick={onUndo} disabled={action.busy}>{action.busy ? <><LoaderCircle className="spin" size={14} />正在撤销</> : "撤销"}</button>
    <button aria-label="关闭撤销提示" disabled={action.busy} onClick={() => controller.clear()}><X size={14} /></button>
  </div>;
}
