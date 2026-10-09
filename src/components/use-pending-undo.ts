"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { PendingUndo } from "@/lib/pending-undo";
const serverSnapshot = () => null;
export function usePendingUndo(active: boolean, blocked: boolean) {
  const controller = useMemo(() => new PendingUndo(), []);
  const action = useSyncExternalStore(controller.subscribe, controller.getSnapshot, serverSnapshot);
  useEffect(() => {
    const visibility = () => controller.pause("hidden", document.hidden);
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); controller.dispose(); };
  }, [controller]);
  useEffect(() => { if (!active) controller.clear(); controller.pause("modal", blocked); }, [active, blocked, controller]);
  return { action, controller };
}
