"use client";
import { useEffect, useId, useRef } from "react";
import "./voyage-scene.css";

/** Animated artwork is isolated from layout, text, and the map's D3 camera. */
export function VoyageScene({ kind }: { kind: "heading" | "sea" }) {
  const ref = useRef<HTMLDivElement>(null), id = useId().replace(/:/g, "");
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let visible = false;
    const update = () => node.dataset.paused = String(!visible || document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    observer.observe(node); document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <div ref={ref} className={`voyage-scene voyage-${kind}`} data-paused="true" aria-hidden="true">
    <svg viewBox="0 0 1200 600" preserveAspectRatio="none" className="voyage-water">
      <defs>
        <linearGradient id={`${id}-water`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--sea-light)"/><stop offset=".52" stopColor="var(--sea-mid)"/><stop offset="1" stopColor="var(--sea-deep)"/></linearGradient>
        <linearGradient id={`${id}-foam`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--sea-foam)" stopOpacity=".6"/><stop offset="1" stopColor="var(--sea-foam)" stopOpacity="0"/></linearGradient>
      </defs>
      <path fill={`url(#${id}-water)`} d="M0 0H1200V600H0Z"/>
      <g className="voyage-current current-back" fill={`url(#${id}-foam)`}>
        <path d="M-200 200C40 30 250 390 510 200S930 40 1400 200V340C1070 90 820 440 540 325S50 180-200 340Z"/>
        <path d="M-200 490C80 300 310 620 600 440S1000 350 1400 510V650H-200Z"/>
      </g>
      <g className="voyage-current current-front" fill="none" stroke="var(--sea-foam)" strokeWidth="1.6">
        <path d="M-200 215C40 45 250 405 510 215S930 55 1400 215M-200 228C40 58 250 418 510 228S930 68 1400 228M-200 241C40 71 250 431 510 241S930 81 1400 241"/>
        <path d="M-200 505C80 315 310 635 600 455S1000 365 1400 525M-200 520C80 330 310 650 600 470S1000 380 1400 540"/>
      </g>
      <g className="voyage-glints" fill="var(--sea-foam)">
        <path d="M145 120h24v2h-24Zm630 220h32v2h-32ZM970 400h22v2h-22ZM360 510h32v2h-32ZM550 72h20v2h-20Z"/>
      </g>
    </svg>
    {kind === "heading" && <svg viewBox="0 0 400 220" className="voyage-compass" fill="none">
      <path className="compass-route" d="M-30 160C70-20 120 250 230 75S320 15 440 150" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 9"/>
      <g transform="translate(205 110)">
        <circle r="94" stroke="currentColor" strokeWidth="1"/><circle r="83" stroke="currentColor" strokeWidth="5" strokeDasharray="1 10"/><circle r="64" stroke="currentColor"/>
        <g className="compass-needle"><path d="M0-58 14 0 0 58-14 0Z" fill="var(--surface)" stroke="currentColor"/><path d="M0-58 14 0 0-6Z" fill="var(--accent)"/><path d="M0 58-14 0 0 6Z" fill="var(--group-blue)"/><circle r="6" fill="var(--warm)" stroke="currentColor"/></g>
        <path d="M0-104v14M0 90v14M-104 0h14M90 0h14" stroke="currentColor" strokeWidth="2"/>
      </g>
      <path d="m52 64 20 9-20 9Z" fill="var(--warm)"/><path d="m325 143 20 9-20 9Z" fill="var(--accent)"/>
    </svg>}
  </div>;
}
