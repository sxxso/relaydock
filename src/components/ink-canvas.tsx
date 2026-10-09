"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
type Stamp = { x: number; y: number; at: number; size: number };
export function InkCanvas({
  enabled,
  panning = false,
  activityRef,
  color = null,
  opacity = 100,
}: {
  enabled: boolean;
  panning?: boolean;
  activityRef?: RefObject<boolean>;
  color?: string | null;
  opacity?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    pan = useRef(panning),
    clearRef = useRef<() => void>(() => {}),
    repaintRef = useRef<() => void>(() => {}),
    visual = useRef({ color, opacity }),
    [allowed, setAllowed] = useState(false);
  pan.current = panning;
  visual.current = { color, opacity };
  useEffect(() => {
    const hover = matchMedia("(hover: hover)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setAllowed(hover.matches && !reduced.matches);
    update();
    hover.addEventListener("change", update);
    reduced.addEventListener("change", update);
    return () => {
      hover.removeEventListener("change", update);
      reduced.removeEventListener("change", update);
    };
  }, []);
  useEffect(() => {
    let el = canvas.current,
      parent = el?.parentElement;
    if (!el || !parent || !enabled || !allowed) return;
    let ctx = el.getContext("2d");
    if (!ctx) return;
    let stamps: Stamp[] = [],
      frame = 0,
      w = 0,
      h = 0,
      dpr = 1,
      last = 0,
      themeColor = "";
    const isBusy = () => activityRef?.current ?? pan.current;
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      stamps = [];
      ctx!.clearRect(0, 0, w, h);
      el.dataset.animating = "false";
    };
    clearRef.current = clear;
    const resize = () => {
      let r = parent.getBoundingClientRect();
      w = r.width;
      h = r.height;
      dpr = Math.min(devicePixelRatio || 1, 2);
      el.width = w * dpr;
      el.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      themeColor =
        getComputedStyle(parent).getPropertyValue("--ink-decoration").trim() ||
        "97,124,113";
    };
    resize();
    let observer = new ResizeObserver(resize);
    observer.observe(parent);
    const draw = (now: number) => {
      frame = 0;
      if (isBusy()) {
        clear();
        return;
      }
      ctx!.clearRect(0, 0, w, h);
      stamps = stamps.filter((s) => now - s.at < 550);
      const hex = visual.current.color;
      const color = hex && /^#[0-9a-fA-F]{6}$/.test(hex)
        ? [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(",")
        : themeColor;
      const strength = Math.min(100, Math.max(0, visual.current.opacity)) / 100;
      for (const s of stamps) {
        let t = (now - s.at) / 550,
          r = s.size * (0.45 + 0.55 * t),
          g = ctx!.createRadialGradient(s.x, s.y, 1, s.x, s.y, r);
        g.addColorStop(0, `rgba(${color},${strength * 0.09 * Math.sin(Math.PI * t)})`);
        g.addColorStop(0.6, `rgba(${color},${strength * 0.045 * (1 - t)})`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.ellipse(
          s.x,
          s.y,
          r,
          r * 0.65,
          Math.sin(s.x) * 0.4,
          0,
          Math.PI * 2,
        );
        ctx!.fill();
      }
      if (stamps.length) frame = requestAnimationFrame(draw);
      else {
        frame = 0;
        el.dataset.animating = "false";
      }
    };
    const repaint = () => {
      if (visual.current.opacity <= 0) { clear(); return; }
      if (stamps.length) { cancelAnimationFrame(frame); draw(performance.now()); }
    };
    repaintRef.current = repaint;
    const move = (e: PointerEvent) => {
      if (
        isBusy() ||
        visual.current.opacity <= 0 ||
        e.buttons !== 0 ||
        e.pointerType === "touch" ||
        (e.target as Element).closest("button,a,input,[data-node]")
      )
        return;
      let now = performance.now();
      if (now - last < 25) return;
      last = now;
      let r = parent.getBoundingClientRect();
      stamps.push({
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        at: now,
        size: 60 + Math.abs(Math.sin(e.clientX)) * 34,
      });
      if (stamps.length > 40) stamps.shift();
      if (!frame) {
        el.dataset.animating = "true";
        frame = requestAnimationFrame(draw);
      }
    };
    parent.addEventListener("pointermove", move, { passive: true });
    // Map activity mutates its ref and data-panning together. Observe only
    // that boundary to cancel existing ink immediately, without idle RAF or
    // a React render. Draw/move also read the live ref, never a copied value.
    const activityObserver = activityRef
      ? new MutationObserver(() => {
          if (isBusy()) clear();
        })
      : null;
    activityObserver?.observe(parent, {
      attributes: true,
      attributeFilter: ["data-panning"],
    });
    const themeObserver = new MutationObserver(() => {
      themeColor = getComputedStyle(parent)
        .getPropertyValue("--ink-decoration")
        .trim() || "97,124,113";
      repaint();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    return () => {
      activityObserver?.disconnect();
      themeObserver.disconnect();
      observer.disconnect();
      parent.removeEventListener("pointermove", move);
      clear();
      if (clearRef.current === clear) clearRef.current = () => {};
      if (repaintRef.current === repaint) repaintRef.current = () => {};
    };
  }, [enabled, allowed, activityRef]);
  useEffect(() => { repaintRef.current(); }, [color, opacity]);
  useEffect(() => {
    if (activityRef?.current ?? panning) clearRef.current();
  }, [panning, activityRef]);
  return (
    <canvas
      ref={canvas}
      className="ink-canvas"
      aria-hidden="true"
      data-animating="false"
    />
  );
}
