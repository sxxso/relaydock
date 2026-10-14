"use client";
import { useEffect, useRef } from "react";
import "./motion-edition.css";

// Adapted from huangj17/login-animated-characters and arsh342/careercompass.
// Source and MIT notices: docs/MOTION-SOURCES.md. No password value enters this component.
export function LoginCompanions({ state }: { state: "idle" | "private" | "peek" | "busy" | "error" }) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const move = (e: PointerEvent) => {
      if (reduced.matches || document.documentElement.dataset.motion === "false" || e.pointerType === "touch") return;
      const box = el.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (e.clientX - box.left - box.width / 2) / (box.width / 2)));
      const y = Math.max(-1, Math.min(1, (e.clientY - box.top - box.height / 2) / (box.height / 2)));
      el.style.setProperty("--look-x", `${x * 7}px`);
      el.style.setProperty("--look-y", `${y * 5}px`);
      el.style.setProperty("--lean", `${x * 4}deg`);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return <div className="companions-scene" ref={stage} data-state={state} aria-hidden="true">
    <div className="companions-orbit orbit-one" /><div className="companions-orbit orbit-two" />
    <span className="scene-star star-one">✦</span><span className="scene-star star-two">✧</span>
    <div className="companions-floor" />
    {["purple", "ink", "coral", "gold"].map((color, index) => <div key={color} className={`companion companion-${color}`} style={{ animationDelay: `${index * 90}ms` }}>
      <div className="companion-body">
        <div className="companion-face">
          <span className="companion-eye"><i /></span><span className="companion-eye"><i /></span>
          <span className="companion-mouth" />
        </div>
        <span className="companion-hand hand-left" /><span className="companion-hand hand-right" />
      </div>
    </div>)}
    <div className="companion-caption">{state === "private" ? "你输入密码，我们看风景。" : state === "peek" ? "好吧，只偷偷看一眼。" : state === "busy" ? "正在为你打开群岛…" : state === "error" ? "再试一次，我们还在。" : "你的群岛，有我们守候。"}</div>
  </div>;
}
