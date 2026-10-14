"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
type Stamp = { x: number; y: number; at: number; size: number; angle: number };
export function InkCanvas({
  enabled,
  panning = false,
  activityRef,
  color = null,
  opacity = 100,
  variant = "wake",
}: {
  enabled: boolean;
  panning?: boolean;
  activityRef?: RefObject<boolean>;
  color?: string | null;
  opacity?: number;
  variant?: "wake" | "stardust" | "orbit";
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    pan = useRef(panning),
    clearRef = useRef<() => void>(() => {}),
    repaintRef = useRef<() => void>(() => {}),
    visual = useRef({ color, opacity, variant }),
    [allowed, setAllowed] = useState(false);
  pan.current = panning;
  visual.current = { color, opacity, variant };
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
      lastPaint = 0,
      previous: { x: number; y: number } | null = null,
      themeColor = "";
    const isBusy = () => activityRef?.current ?? pan.current;
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      stamps = [];
      previous = null;
      ctx!.clearRect(0, 0, w, h);
      el.dataset.animating = "false";
    };
    clearRef.current = clear;
    const resize = () => {
      let r = parent.getBoundingClientRect();
      w = r.width;
      h = r.height;
      // Soft ink does not need retina resolution; cap backing pixels on large maps.
      dpr = Math.min(devicePixelRatio || 1, 1.25, Math.sqrt(1_600_000 / Math.max(1, w*h)));
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
      if (isBusy() || document.hidden) {
        clear();
        return;
      }
      if (now-lastPaint < 32) { frame=requestAnimationFrame(draw);return; }
      lastPaint=now;
      ctx!.clearRect(0, 0, w, h);
      stamps = stamps.filter((s) => now - s.at < 950);
      const hex = visual.current.color;
      const color = hex && /^#[0-9a-fA-F]{6}$/.test(hex)
        ? [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(",")
        : themeColor;
      const strength = Math.min(100, Math.max(0, visual.current.opacity)) / 100;
      for (const s of stamps) {
        const age = (now-s.at)/950;
        if (visual.current.variant !== "wake") {
          ctx!.save();ctx!.translate(s.x,s.y);ctx!.rotate(s.angle+age*.7);
          ctx!.strokeStyle=`rgba(${color},${strength*.7*(1-age)})`;
          ctx!.fillStyle=`rgba(${color},${strength*.6*(1-age)})`;
          ctx!.lineWidth=1;
          if (visual.current.variant === "stardust") {
            for (let j=0;j<3;j++) {
              const x=(j-1)*s.size*(.6+age), y=Math.sin(j*2+s.angle)*s.size*age, r=(3+j)*(1-age);
              ctx!.beginPath();ctx!.moveTo(x-r,y);ctx!.quadraticCurveTo(x,y,x,y-r);ctx!.quadraticCurveTo(x,y,x+r,y);ctx!.quadraticCurveTo(x,y,x,y+r);ctx!.quadraticCurveTo(x,y,x-r,y);ctx!.fill();
            }
          } else {
            const radius=s.size*(.4+age);
            ctx!.beginPath();ctx!.ellipse(0,0,radius,radius*.45,0,age*3,age*3+Math.PI*1.6);ctx!.stroke();
            ctx!.beginPath();ctx!.arc(Math.cos(age*5)*radius,Math.sin(age*5)*radius*.45,2,0,Math.PI*2);ctx!.fill();
          }
          ctx!.restore();continue;
        }
        let t = (now - s.at) / 950,
          r = s.size * (0.5 + 0.8 * t),
          g = ctx!.createRadialGradient(s.x, s.y, 1, s.x, s.y, r);
        g.addColorStop(0, `rgba(${color},${strength * 0.16 * (1-t)})`);
        g.addColorStop(0.6, `rgba(${color},${strength * 0.07 * (1 - t)})`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.ellipse(
          s.x,
          s.y,
          r,
          r * 0.65,
          s.angle,
          0,
          Math.PI * 2,
        );
        ctx!.fill();
        // Broken capillary rings and a fine tail replace broad blurred blobs.
        ctx!.strokeStyle = `rgba(${color},${strength * .27 * (1-t) ** 2})`;
        ctx!.lineWidth = .8;
        ctx!.beginPath();
        ctx!.ellipse(s.x, s.y, r, r*.62, s.angle, .3, Math.PI*1.75);
        ctx!.stroke();
        ctx!.beginPath();
        ctx!.moveTo(s.x, s.y);
        ctx!.lineTo(s.x-Math.cos(s.angle)*r*1.5, s.y-Math.sin(s.angle)*r*1.5);
        ctx!.stroke();
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
        (e.target as Element).closest("button,a,input,select,summary,[data-node],[data-map-control],.ink-island")
      ) {
        previous = null;
        return;
      }
      let now = performance.now();
      if (now - last < 25) return;
      last = now;
      let r = parent.getBoundingClientRect();
      const x = e.clientX-r.left, y = e.clientY-r.top;
      const distance = previous ? Math.hypot(x-previous.x,y-previous.y) : 12;
      if (distance < 8) return;
      const angle = previous ? Math.atan2(y-previous.y,x-previous.x) : 0;
      previous = { x, y };
      stamps.push({
        x, y, angle,
        at: now,
        size: Math.min(30, 10+distance*.18),
      });
      if (stamps.length > 16) stamps.shift();
      if (!frame) {
        el.dataset.animating = "true";
        frame = requestAnimationFrame(draw);
      }
    };
    parent.addEventListener("pointermove", move, { passive: true });
    parent.addEventListener("pointerleave", clear);
    const visibility = () => { if (document.hidden) clear(); };
    document.addEventListener("visibilitychange", visibility);
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
      parent.removeEventListener("pointerleave", clear);
      document.removeEventListener("visibilitychange", visibility);
      clear();
      if (clearRef.current === clear) clearRef.current = () => {};
      if (repaintRef.current === repaint) repaintRef.current = () => {};
    };
  }, [enabled, allowed, activityRef]);
  useEffect(() => { clearRef.current(); }, [variant]);
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
      data-effect={variant}
    />
  );
}
