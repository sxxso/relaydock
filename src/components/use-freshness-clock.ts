"use client";
import { useEffect, useState } from "react";
import { watchRecordClock } from "@/lib/balance-freshness";

// One clock for the workspace, not one timer per account. Never performs I/O.
export function useFreshnessClock(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    return watchRecordClock(setNow, {
      now: () => Date.now(),
      visible: () => document.visibilityState !== "hidden",
      schedule(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      subscribe(callback) {
        document.addEventListener("visibilitychange", callback);
        return () => document.removeEventListener("visibilitychange", callback);
      },
    });
  }, [enabled]);
  return now;
}
