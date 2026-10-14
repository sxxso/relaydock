"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";

export function ListCruise({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [reduced, setReduced] = useState(false);
  const active = enabled && running && !hovered && !focused && overflow && !reduced;
  useEffect(() => {
    const el = viewport.current!;
    const measure = () => setOverflow(el.scrollHeight > el.clientHeight + 2);
    const observer = new ResizeObserver(measure);
    observer.observe(el); for (const child of el.children) observer.observe(child);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);update();media.addEventListener('change',update);
    measure();return () => { observer.disconnect();media.removeEventListener('change',update); };
  }, [children]);
  useEffect(() => {
    const el = viewport.current;
    if (!el || !active) return;
    let frame = 0, last = 0, position = el.scrollTop, direction = 1, hold = 0, visible = true;
    const stop = () => { cancelAnimationFrame(frame);frame=0;last=0; };
    const step = (now: number) => {
      if (last && now > hold) {
        position += Math.min(now-last,50) * .018 * direction;
        const limit = el.scrollHeight-el.clientHeight;
        if (position >= limit || position <= 0) { position=Math.max(0,Math.min(limit,position));direction*=-1;hold=now+1400; }
        el.scrollTop=position;
      }
      last=now;frame=requestAnimationFrame(step);
    };
    const sync = () => { stop();if (!document.hidden && visible) frame=requestAnimationFrame(step); };
    const observer = new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();});observer.observe(el);
    document.addEventListener('visibilitychange',sync);sync();
    return () => {stop();observer.disconnect();document.removeEventListener('visibilitychange',sync);};
  }, [active]);
  return <>
    <div className="list-cruise-bar"><small>{!overflow ? '全部站点已展示' : active ? '缓缓巡览 · 悬停即停' : '巡览已暂停，可手动滚动'}</small><button type="button" aria-pressed={running} disabled={!enabled || reduced || !overflow} onClick={()=>setRunning(v=>!v)}>{running ? <Pause size={13}/> : <Play size={13}/>}自动巡览</button></div>
    <div ref={viewport} className="list-cruise-viewport" aria-label="站点列表" tabIndex={0} onPointerEnter={()=>setHovered(true)} onPointerLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))setFocused(false);}} onWheel={()=>setRunning(false)} onTouchStart={()=>setRunning(false)}>{children}</div>
  </>;
}
