"use client";
import { useEffect, useRef, type RefObject } from "react";
import { Send } from "lucide-react";
import "./map-story.css";

/** Screen-space decorations never change the D3 world or receive pointer input. */
export function MapStory({ host, selected, enabled }: {
  host: RefObject<HTMLDivElement | null>; selected: string | null; enabled: boolean;
}) {
  const boat = useRef<HTMLDivElement>(null), plane = useRef<HTMLDivElement>(null),
    signal = useRef<HTMLDivElement>(null), route = useRef<SVGPathElement>(null);
  useEffect(() => {
    const root = host.current, ship = boat.current;
    if (!root || !ship || !enabled) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, previousTime = 0, visible = false;
    let bounds = root.getBoundingClientRect();
    let target = { x: 90, y: 180 }, position = { ...target };
    const measure = () => { bounds = root.getBoundingClientRect(); };
    const resize = new ResizeObserver(measure); resize.observe(root);
    const tick = (now: number) => {
      frame = 0;
      const dt = Math.min(40, previousTime ? now-previousTime : 16.7);
      previousTime = now;
      const dx=target.x-position.x, dy=target.y-position.y;
      const alpha=1-Math.exp(-dt/95);
      position.x+=dx*alpha;position.y+=dy*alpha;
      ship.style.transform=`translate3d(${position.x.toFixed(2)}px,${position.y.toFixed(2)}px,0)`;
      ship.style.setProperty('--boat-heel',`${Math.max(-14,Math.min(14,dx*.18)).toFixed(1)}deg`);
      if(Math.hypot(dx,dy)>.25)frame=requestAnimationFrame(tick);
      else {previousTime=0;ship.dataset.tracking='false';}
    };
    const stop = () => {
      cancelAnimationFrame(frame); frame = 0; previousTime=0;visible=false;
      ship.dataset.visible = "false";
      ship.dataset.tracking = "false";
    };
    const move = (event: PointerEvent) => {
      if (reduced.matches || document.hidden || event.buttons || event.pointerType === "touch" || root.dataset.panning === "true") { stop(); return; }
      if ((event.target as Element).closest("button,summary,input,[data-node],[data-map-control],.ink-island,[role=combobox],.map-minimap")) { stop(); return; }
      const r = bounds;
      target = { x: Math.max(28, Math.min(r.width-28, event.clientX-r.left-35)), y: Math.max(28, Math.min(r.height-28,event.clientY-r.top+28)) };
      if(!visible){position={x:target.x-12,y:target.y+4};visible=true;ship.dataset.visible='true';}
      if (!frame) { ship.dataset.tracking='true';frame=requestAnimationFrame(tick); }
    };
    const activity = new MutationObserver(() => { if(root.dataset.panning === "true") stop(); });
    activity.observe(root,{attributes:true,attributeFilter:["data-panning"]});
    root.addEventListener("pointermove",move,{passive:true}); root.addEventListener("pointerleave",stop);
    root.addEventListener('pointerenter',measure);window.addEventListener('scroll',measure,true);
    document.addEventListener("visibilitychange",stop); reduced.addEventListener("change",stop);
    return () => { stop(); resize.disconnect();activity.disconnect();root.removeEventListener('pointerenter',measure);window.removeEventListener('scroll',measure,true); root.removeEventListener("pointermove",move);root.removeEventListener("pointerleave",stop);document.removeEventListener("visibilitychange",stop);reduced.removeEventListener("change",stop); };
  }, [enabled,host]);
  useEffect(()=>{
    const root=host.current,mark=signal.current;if(!root||!mark||!enabled)return;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    let animations:Animation[]=[],down:{x:number;y:number}|null=null;
    const stop=()=>{animations.forEach(a=>a.cancel());animations=[];};
    const burst=(x:number,y:number)=>{
      stop();mark.style.transform=`translate3d(${x}px,${y}px,0)`;
      animations=Array.from(mark.children).map((el,i)=>el.animate([
        {opacity:0,transform:`rotate(${i*30}deg) translateY(-8px) scale(.2)`},
        {opacity:.9,offset:.2,transform:`rotate(${i*30}deg) translateY(-28px) scale(1)`},
        {opacity:0,transform:`rotate(${i*30+12}deg) translateY(-65px) scale(.4)`},
      ],{duration:900+i%3*90,easing:'cubic-bezier(.2,.6,.3,1)'}));
    };
    const start=(e:PointerEvent)=>{down=e.button===0?{x:e.clientX,y:e.clientY}:null;};
    const click=(e:PointerEvent)=>{
      const origin=down;down=null;
      if(!origin||Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>5||reduced.matches||document.hidden)return;
      if((e.target as Element).closest('button,summary,input,[data-node],[data-map-control],.ink-island,[role=combobox],.map-minimap'))return;
      const r=root.getBoundingClientRect();burst(e.clientX-r.x,e.clientY-r.y);
    };
    const arrival=(e:Event)=>{if(reduced.matches||document.hidden)return;const {x,y}=(e as CustomEvent<{x:number;y:number}>).detail;burst(x,y);};
    const activity=new MutationObserver(()=>{if(root.dataset.panning==='true')stop();});
    activity.observe(root,{attributes:true,attributeFilter:['data-panning']});
    root.addEventListener('pointerdown',start);root.addEventListener('pointerup',click);root.addEventListener('harbor-arrival',arrival);
    document.addEventListener('visibilitychange',stop);reduced.addEventListener('change',stop);
    return()=>{stop();activity.disconnect();root.removeEventListener('pointerdown',start);root.removeEventListener('pointerup',click);root.removeEventListener('harbor-arrival',arrival);document.removeEventListener('visibilitychange',stop);reduced.removeEventListener('change',stop);};
  },[enabled,host]);
  useEffect(() => {
    const root = host.current, courier = plane.current;
    if (!root || !courier || !selected || !enabled) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let flight: Animation | undefined, trail:Animation|undefined;
    const stop = () => { flight?.cancel();trail?.cancel(); courier.dataset.flying="false"; };
    // Let the detail column and camera settle before measuring the destination.
    let timer = 0, attempts = 0;
    const launch = () => {
      if (reduced.matches || document.hidden) return;
      if (root.dataset.panning === "true") {
        if (++attempts < 25) timer=window.setTimeout(launch,80);
        return;
      }
      const destination = root.querySelector(`[data-account-id="${CSS.escape(selected)}"] .node-core`);
      if (!destination) return;
      const r=root.getBoundingClientRect(), d=destination.getBoundingClientRect();
      const x=d.x+d.width/2-r.x, y=d.y+d.height/2-r.y;
      if(x<0||y<0||x>r.width||y>r.height)return;
      courier.dataset.flying="true";
      const path=`M48 ${r.height-80} Q${Math.max(55,x*.3)} ${Math.max(32,y-130)} ${x} ${y}`;
      courier.style.offsetPath=`path('${path}')`;
      route.current?.setAttribute('d',path);
      trail=route.current?.animate([{strokeDashoffset:1,opacity:0},{strokeDashoffset:.1,opacity:.6,offset:.75},{strokeDashoffset:0,opacity:0}],{duration:1500,easing:'ease-out'});
      flight=courier.animate([
        {offsetDistance:'0%',transform:'scale(.6)',opacity:0},
        {offsetDistance:'18%',transform:'scale(1.1)',opacity:1,offset:.2},
        {offsetDistance:'85%',transform:'scale(1)',opacity:1,offset:.8},
        {offsetDistance:'100%',transform:'scale(.3)',opacity:0},
      ],{duration:1250,easing:"ease-in-out"});
      flight.finished.then(()=>{root.dispatchEvent(new CustomEvent('harbor-arrival',{detail:{x,y}}));stop();},()=>{});
    };
    timer=window.setTimeout(launch,480);
    const activity=new MutationObserver(()=>{if(root.dataset.panning==='true')stop()});activity.observe(root,{attributes:true,attributeFilter:['data-panning']});
    document.addEventListener('visibilitychange',stop);reduced.addEventListener('change',stop);
    return ()=>{clearTimeout(timer);stop();activity.disconnect();document.removeEventListener('visibilitychange',stop);reduced.removeEventListener('change',stop);};
  },[selected,enabled,host]);
  return <div className="map-story" aria-hidden="true">
    <svg className="courier-route"><path ref={route} pathLength="1" /></svg>
    <div ref={signal} className="harbor-signal">{Array.from({length:12},(_,i)=><i key={i} />)}</div>
    <div ref={boat} className="paper-boat" data-visible="false">
      <svg viewBox="0 0 64 54" width="64" height="54"><g className="boat-wake" fill="none" stroke="currentColor"><path d="M3 43Q16 38 27 43T54 43"/><path d="M9 49Q20 44 33 49T59 49"/></g><g className="boat-fold"><path d="M12 30 31 5 31 32Z" fill="#fffdf6" stroke="#638d9b"/><path d="M31 5 49 30 31 32Z" fill="#d3e4e8" stroke="#638d9b"/><path d="M4 31 59 31 47 42 17 42Z" fill="#cc7c64" stroke="#945342"/><path d="M4 31 31 36 59 31" fill="none" stroke="#f8dac5"/></g></svg>
    </div>
    <div ref={plane} className="site-courier" data-flying="false"><Send size={34} strokeWidth={1.5}/><span className="courier-trail" /></div>
  </div>;
}
