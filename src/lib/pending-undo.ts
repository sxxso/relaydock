import type { UndoEntry } from "./undo";

export type PendingUndoAction = {
  id: number; message: string; entries: UndoEntry[]; seconds: number; busy: boolean; error: string;
};
const WINDOW_MS = 6000;
/** One in-memory action. Time only runs while its notice can be used. */
export class PendingUndo {
  private snapshot: PendingUndoAction | null = null;
  private listeners = new Set<() => void>();
  private pauses = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remaining = WINDOW_MS;
  private started = 0;
  private sequence = 0;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { this.listeners.forEach((listener) => listener()); }
  private stop() {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.remaining = Math.max(0, this.remaining - (Date.now() - this.started)); }
    this.timer = undefined;
  }
  private run() {
    if (!this.snapshot || this.snapshot.busy || this.pauses.size) return;
    if (this.remaining <= 0) { this.clear(); return; }
    this.started = Date.now();
    this.timer = setTimeout(() => {
      this.stop();
      if (this.remaining <= 0) this.clear();
      else {
        this.snapshot = { ...this.snapshot!, seconds: Math.ceil(this.remaining / 1000) };
        this.emit(); this.run();
      }
    }, Math.min(1000, this.remaining));
  }
  offer(message: string, entries: UndoEntry[]) {
    if (!entries.length) return;
    this.stop(); this.remaining = WINDOW_MS;
    this.snapshot = {
      id: ++this.sequence, message, seconds: 6, busy: false, error: "",
      entries: entries.map((entry) => ({ ...entry, restore: { ...entry.restore, ...(entry.restore.tags ? { tags: [...entry.restore.tags] } : {}) } })),
    };
    this.emit(); this.run();
  }
  clear() { this.stop(); this.snapshot = null; this.emit(); }
  pause(reason: string, paused: boolean) {
    if (this.pauses.has(reason) === paused) return;
    this.stop(); paused ? this.pauses.add(reason) : this.pauses.delete(reason); this.run();
  }
  begin() {
    if (!this.snapshot || this.snapshot.busy) return null;
    this.stop(); this.snapshot = { ...this.snapshot, busy: true, error: "" }; this.emit();
    return this.snapshot;
  }
  succeed(id: number) { if (this.snapshot?.id === id) this.clear(); }
  fail(id: number, error: string, retryable = true) {
    if (this.snapshot?.id !== id) return;
    if (!retryable) { this.clear(); return; }
    this.remaining = WINDOW_MS;
    this.snapshot = { ...this.snapshot, busy: false, error, seconds: 6 }; this.emit(); this.run();
  }
  dispose() { this.stop(); this.listeners.clear(); }
}

/** Mutation responses can finish out of order, just like account GETs. */
export function mergeLatestAccounts<T extends { id: string; updatedAt: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(incoming.map((account) => [account.id, account]));
  return current.map((account) => {
    const next = byId.get(account.id);
    return next && Date.parse(next.updatedAt) >= Date.parse(account.updatedAt) ? next : account;
  });
}
