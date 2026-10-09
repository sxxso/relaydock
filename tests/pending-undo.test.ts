import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingUndo, mergeLatestAccounts } from "../src/lib/pending-undo";
const entries = [{ id: "fixture", expectedUpdatedAt: "2026-10-07T01:00:00.000Z", restore: { favorite: false, tags: ["old"] } }];
describe("a short, retryable, latest-action undo window", () => {
  let undo: PendingUndo;
  beforeEach(() => { vi.useFakeTimers(); undo = new PendingUndo(); });
  afterEach(() => { undo.dispose(); vi.useRealTimers(); });
  it("expires after six visible idle seconds and releases timers", () => {
    undo.offer("已加入收藏", entries); vi.advanceTimersByTime(5000);
    expect(undo.getSnapshot()?.seconds).toBe(1); vi.advanceTimersByTime(1000);
    expect(undo.getSnapshot()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("pauses while the notice is hovered or focused, then uses the remaining time", () => {
    undo.offer("old", entries); vi.advanceTimersByTime(2000); undo.pause("focus", true);
    undo.pause("pointer", true); vi.advanceTimersByTime(20000);
    expect(undo.getSnapshot()?.seconds).toBe(4);
    undo.pause("focus", false); vi.advanceTimersByTime(20000); expect(undo.getSnapshot()).not.toBeNull();
    undo.pause("pointer", false); vi.advanceTimersByTime(4000); expect(undo.getSnapshot()).toBeNull();
  });
  it("does not expire a pending request or start duplicate requests", () => {
    undo.offer("old", entries); const action = undo.begin()!;
    expect(undo.begin()).toBeNull(); vi.advanceTimersByTime(20000);
    expect(undo.getSnapshot()?.busy).toBe(true); undo.succeed(action.id);
    expect(undo.getSnapshot()).toBeNull();
  });
  it("retains a new action while hidden or blocked by a dialog until both pauses end", () => {
    undo.pause("hidden", true); undo.pause("modal", true); undo.offer("new", entries);
    vi.advanceTimersByTime(20000); expect(undo.getSnapshot()?.seconds).toBe(6);
    undo.pause("hidden", false); vi.advanceTimersByTime(20000);
    expect(undo.getSnapshot()?.seconds).toBe(6); expect(vi.getTimerCount()).toBe(0);
    undo.pause("modal", false); vi.advanceTimersByTime(5999);
    expect(undo.getSnapshot()).not.toBeNull(); vi.advanceTimersByTime(1);
    expect(undo.getSnapshot()).toBeNull();
  });
  it("counts partial idle seconds rather than granting a new window at each pause", () => {
    undo.offer("old", entries); vi.advanceTimersByTime(650); undo.pause("pointer", true);
    vi.advanceTimersByTime(20000); undo.pause("pointer", false);
    vi.advanceTimersByTime(5349); expect(undo.getSnapshot()).not.toBeNull();
    vi.advanceTimersByTime(1); expect(undo.getSnapshot()).toBeNull();
  });
  it("keeps exact snapshots and a fresh retry window after a network failure", () => {
    undo.offer("old", entries); const action = undo.begin()!;
    vi.advanceTimersByTime(20000); undo.fail(action.id, "网络失败");
    expect(undo.getSnapshot()).toMatchObject({ busy: false, error: "网络失败", seconds: 6, entries });
    expect(undo.begin()?.entries).toEqual(entries);
  });
  it("an old response cannot clear or mark an error on a newer action", () => {
    undo.offer("old", entries); const old = undo.begin()!;
    undo.offer("new", [{ ...entries[0], id: "new" }]);
    undo.succeed(old.id); undo.fail(old.id, "old failure");
    expect(undo.getSnapshot()).toMatchObject({ message: "new", busy: false, error: "" });
  });
  it("does not retain candidate array references or create empty undo actions", () => {
    const candidate = [{ ...entries[0], restore: { tags: ["a"] } }];
    undo.offer("tags", candidate); candidate[0].restore.tags.push("b");
    expect(undo.getSnapshot()?.entries[0].restore.tags).toEqual(["a"]);
    undo.offer("empty", []); expect(undo.getSnapshot()?.message).toBe("tags");
  });
  it("clears a terminal failure and discarded or signed-out actions", () => {
    undo.offer("old", entries); undo.fail(undo.begin()!.id, "deleted", false);
    expect(undo.getSnapshot()).toBeNull(); undo.offer("new", entries); undo.clear();
    expect(undo.getSnapshot()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("subscribers see stable snapshots and can unsubscribe", () => {
    const changed = vi.fn(), stop = undo.subscribe(changed);
    undo.offer("old", entries); expect(changed).toHaveBeenCalledTimes(1);
    expect(undo.getSnapshot()).toBe(undo.getSnapshot()); stop(); undo.clear();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
describe("canonical undo responses arriving out of order", () => {
  it("cannot overwrite a newer account result and cannot resurrect a removed account", () => {
    const current = [{ id: "a", updatedAt: "2026-10-07T02:00:00.000Z", favorite: true }];
    expect(mergeLatestAccounts(current, [{ ...current[0], updatedAt: "2026-10-07T01:00:00.000Z", favorite: false }, { ...current[0], id: "deleted" }])).toEqual(current);
  });
  it("accepts a newer result without touching unrelated accounts", () => {
    const current = [{ id: "a", updatedAt: "2026-10-07T01:00:00.000Z", favorite: true }, { id: "b", updatedAt: "2026-10-07T01:00:00.000Z", favorite: true }];
    const changed = { ...current[0], updatedAt: "2026-10-07T02:00:00.000Z", favorite: false };
    expect(mergeLatestAccounts(current, [changed])).toEqual([changed, current[1]]);
  });
});
