"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LocateFixed } from "lucide-react";
import type { Account } from "@/lib/validation";
import { balanceFreshness } from "@/lib/balance-freshness";
import { displayAmount, isLow } from "@/lib/money";
import { Modal } from "./modal";
import "./harbor-pet.css";

// Original pixel geometry, rendered locally. No remote assets or account requests.
function PixelPet({ large = false }: { large?: boolean }) {
  return <svg className={large ? "pixel-pet large" : "pixel-pet"} viewBox="0 0 40 48" shapeRendering="crispEdges" aria-hidden="true">
    <ellipse className="pet-shadow" cx="20" cy="45" rx="13" ry="2" />
    <g className="pet-body">
      <path fill="#c9856b" d="M8 10h24v3h3v21H5V13h3Z" />
      <path fill="#dda085" d="M8 10h24v3H8Z" />
      <g className="pet-face"><path fill="#292824" d="M12 19h3v6h-3ZM25 19h3v6h-3Z" /></g>
      <path className="pet-arm left" fill="#c9856b" d="M2 22h3v10H2Z" />
      <path className="pet-arm right" fill="#c9856b" d="M35 22h3v10h-3Z" />
    </g>
    <path className="pet-leg left" fill="#c9856b" d="M8 34h4v8H8Zm7 0h4v7h-4Z" />
    <path className="pet-leg right" fill="#c9856b" d="M22 34h4v7h-4Zm7 0h4v8h-4Z" />
    <g className="pet-glass"><path fill="#33495a" d="M22 12h11v3H22ZM22 21h11v3H22ZM20 15h3v6h-3ZM32 15h3v6h-3ZM33 23h3v3h-3ZM36 26h3v3h-3Z" /><path fill="#d6f0ee" d="M24 15h7v6h-7Z" /></g>
    <path className="pet-spark" fill="#d4a938" d="M34 2h2v3h3v2h-3v3h-2V7h-3V5h3Z" />
  </svg>;
}

export function HarborPet({ accounts, selected, searching, busy, motion, now, open, onOpenChange, onLocate }: {
  accounts: Account[]; selected: Account | null; searching: boolean; busy: boolean;
  motion: boolean; now: number; open: boolean; onOpenChange: (open: boolean) => void; onLocate: (account: Account) => void;
}) {
  const stage = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0);
  const [watching, setWatching] = useState<string | null>(null);
  const active = accounts.filter(a => !a.archived);
  const [mode, setMode] = useState<"overview" | "site">("overview");
  const account = active[index % Math.max(active.length, 1)];
  const freshness = account ? balanceFreshness(account, now) : null;
  const spotted = active.find(a => a.id === watching);
  const state = busy ? "busy" : searching ? "search" : spotted ? "scout" : selected ? "wave" : "idle";
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-account-id],[data-site-row]') : null;
      if (!target) return;
      clearTimeout(timer);
      setWatching(target.getAttribute('data-account-id') || target.getAttribute('data-site-row'));
      timer = setTimeout(()=>setWatching(null),3500);
    };
    document.addEventListener('pointerover',watch);document.addEventListener('focusin',watch);
    return ()=>{clearTimeout(timer);document.removeEventListener('pointerover',watch);document.removeEventListener('focusin',watch);};
  }, []);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let visible = true;
    const update = () => el.dataset.paused = String(!visible || document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    observer.observe(el); document.addEventListener("visibilitychange", update); update();
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => {
    const el = stage.current;
    if (!el || !motion) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, x = 0, y = 0;
    const move = (event: PointerEvent) => {
      if (reduced.matches || event.pointerType === "touch" || document.hidden || el.dataset.paused === "true") return;
      x = event.clientX; y = event.clientY;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--pet-look-x", `${Math.max(-2, Math.min(2, (x-r.x-r.width/2)/150))}px`);
        el.style.setProperty("--pet-look-y", `${Math.max(-1, Math.min(1, (y-r.y-r.height/2)/200))}px`);
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => { window.removeEventListener("pointermove", move); cancelAnimationFrame(frame); el.style.removeProperty("--pet-look-x"); el.style.removeProperty("--pet-look-y"); };
  }, [motion]);
  const greet = () => {
    const chosen = spotted ? active.findIndex(a => a.id === spotted.id) : selected ? active.findIndex(a => a.id === selected.id) : -1;
    setIndex(Math.max(0, chosen)); setMode(chosen >= 0 ? "site" : "overview"); onOpenChange(true);
  };
  return <>
    <button ref={stage} className="harbor-pet" data-state={state} aria-label="小岛向导：查看站点信息" title="小岛向导：查看站点信息" onClick={greet}>
      <PixelPet /><span className="pet-caption">{busy ? "正在查账…" : searching ? "我来找找" : spotted ? spotted.name : selected ? "这站我认识" : "小岛向导"}</span>
    </button>
    <Modal open={open} onClose={() => onOpenChange(false)} title="小岛向导" description="你的群岛近况，都在这里。">
      <div className="pet-report">
        <div className="pet-greeting" data-state={mode === "site" ? "wave" : "idle"}><PixelPet large /><p>{mode === "site" && account ? <>找到 <strong>{account.name}</strong> 了。</> : active.length ? <>我守着你的 <strong>{active.length}</strong> 个账号。</> : "这里还没有站点，等你的第一座小岛。"}</p></div>
        <div className="pet-tabs" role="group" aria-label="向导信息范围"><button aria-pressed={mode === "overview"} onClick={() => setMode("overview")}>群岛概况</button><button disabled={!active.length} aria-pressed={mode === "site"} onClick={() => setMode("site")}>站点档案</button></div>
        {mode === "overview" ? <>
          <dl className="pet-facts"><div><dt>使用中账号</dt><dd>{active.length}</dd></div><div><dt>站点分组</dt><dd>{new Set(active.map(a => a.group || "未分组")).size}</dd></div><div><dt>低于提醒阈值</dt><dd>{active.filter(isLow).length}</dd></div><div><dt>尚无余额记录</dt><dd>{active.filter(a => a.balance === null).length}</dd></div><div><dt>最近查询失败</dt><dd>{active.filter(a => a.lastSyncStatus === "error").length}</dd></div></dl>
          <p className="pet-note">依据本地已保存记录；站点实时状态需手动查询。</p>
        </> : account && freshness && <>
          <div className="pet-site-picker"><button className="icon-button" aria-label="上一个站点" onClick={() => setIndex(i => (i-1+active.length)%active.length)}><ChevronLeft size={18} /></button><strong>{account.name}</strong><button className="icon-button" aria-label="下一个站点" onClick={() => setIndex(i => (i+1)%active.length)}><ChevronRight size={18} /></button></div>
          <dl className="pet-facts"><div><dt>{freshness.amountLabel}</dt><dd>{displayAmount(account.balance, account.balanceUnit)} <small>{account.balanceUnit}</small></dd></div><div><dt>分组</dt><dd>{account.group || "未分组"}</dd></div><div><dt>记录来源</dt><dd>{freshness.sourceLabel}</dd></div><div><dt>记录时间</dt><dd>{freshness.absoluteTime || "尚无时间记录"}</dd></div><div><dt>查询状态</dt><dd>{freshness.queryLabel}</dd></div></dl>
          <p className="pet-note">{isLow(account) ? "余额已低于你设置的提醒阈值。" : "这是已保存的档案，余额不会自动更新。"}</p>
          <button className="button primary" onClick={() => { onOpenChange(false); onLocate(account); }}><LocateFixed size={16} />查看这个站点</button>
        </>}
      </div>
    </Modal>
  </>;
}
