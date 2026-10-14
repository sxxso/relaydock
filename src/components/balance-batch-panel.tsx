"use client";
import { Check, AlertCircle, Clock, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { Modal } from "./modal";
import type { BalanceBatchRow } from "@/lib/balance-batch";
import "./management-inbox.css";

export function BalanceBatchPanel({ open, rows, running, started, cancelled, scope, skipped, route, onClose, onStart, onCancel, onRetry }: {
  open: boolean; rows: BalanceBatchRow[]; running: boolean; started: boolean; cancelled: boolean;
  scope: string; skipped: number; route: string;
  onClose: () => void; onStart: () => void; onCancel: () => void; onRetry: () => void;
}) {
  const count = (state: BalanceBatchRow["state"]) => rows.filter(r => r.state === state).length;
  const done = count("success") + count("failed") + count("cancelled");
  return <Modal open={open} onClose={onClose} title="批量查询余额" description={`${scope} · ${rows.length} 个可查询账号 · ${route}`} wide>
    <section className="balance-batch-panel">
      <div className="balance-batch-summary" role="status">{!started ? "确认范围后开始查询" : running ? `已完成 ${done} / ${rows.length}` : "本轮查询已结束"}<span>成功 {count("success")} · 失败 {count("failed")} · 未发出 {count("cancelled")}</span></div>
      <progress aria-label="批量查询进度" max={Math.max(1, rows.length)} value={done} />
      {skipped > 0 && <p className="hint">已排除 {skipped} 个手动记录、无凭据、归档或正在处理的账号。</p>}
      {cancelled && running && <p className="hint">已停止排队，正在等待已发出的请求完成。</p>}
      <ul className="balance-batch-results" aria-label="逐站查询结果">
        {rows.map(row => <li key={row.id} data-state={row.state}>
          {row.state === "running" ? <LoaderCircle size={17} className="spin" /> : row.state === "success" ? <Check size={17} /> : row.state === "failed" ? <AlertCircle size={17} /> : row.state === "cancelled" ? <Square size={15} /> : <Clock size={17} />}
          <strong>{row.name}</strong><span>{row.message}</span>
        </li>)}
      </ul>
      <div className="modal-actions">
        <button className="button" onClick={onClose}>{running ? "收起" : "关闭"}</button>
        {!started && <button className="button primary" disabled={!rows.length} onClick={onStart}>开始查询 {rows.length} 个账号</button>}
        {running && <button className="button" disabled={cancelled || count("queued") === 0} onClick={onCancel}><Square size={15} />取消排队</button>}
        {started && !running && count("failed") > 0 && <button className="button primary" onClick={onRetry}><RotateCcw size={16} />仅重试失败项 ({count("failed")})</button>}
      </div>
    </section>
  </Modal>;
}
