"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { computeFilterMenuPosition } from "@/lib/filter-menu-position";

type FilterMenuBinding = {
  node: HTMLDetailsElement;
  update: () => void;
  dispose: () => void;
};

const positionProperties = [
  "--filter-menu-width",
  "--filter-menu-left",
  "--filter-menu-top",
  "--filter-menu-max-height",
] as const;

function bindFilterMenu(node: HTMLDetailsElement): FilterMenuBinding | null {
  const anchor = node.querySelector<HTMLElement>(":scope > summary");
  const panel = node.querySelector<HTMLDivElement>(":scope > div");
  const doc = node.ownerDocument;
  const win = doc.defaultView;
  if (!anchor || !panel || !win) return null;

  let frame: number | null = null;
  const write = (property: string, value: number) => {
    const pixels = `${value}px`;
    if (panel.style.getPropertyValue(property) !== pixels)
      panel.style.setProperty(property, pixels);
  };
  const cancelFrame = () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
  };
  const update = () => {
    cancelFrame();
    if (!node.open || !node.isConnected) {
      node.removeAttribute("data-filter-menu-positioned");
      return;
    }
    const visible = win.visualViewport;
    const viewport = {
      width: visible?.width ?? (doc.documentElement.clientWidth || win.innerWidth),
      height: visible?.height ?? win.innerHeight,
      offsetLeft: visible?.offsetLeft ?? 0,
      offsetTop: visible?.offsetTop ?? 0,
    };
    const rect = anchor.getBoundingClientRect();
    // Resolve width first: wrapping changes natural height. Offset/scroll metrics
    // avoid measuring the panel's animated, temporarily scaled bounding rect.
    write("--filter-menu-width", computeFilterMenuPosition({
      anchor: rect, viewport, panelHeight: 0,
    }).width);
    const position = computeFilterMenuPosition({
      anchor: rect,
      viewport,
      panelHeight: panel.scrollHeight + panel.offsetHeight - panel.clientHeight,
    });
    write("--filter-menu-left", position.left);
    write("--filter-menu-top", position.top);
    write("--filter-menu-max-height", position.maxHeight);
    if (node.dataset.filterMenuSide !== position.side)
      node.dataset.filterMenuSide = position.side;
    if (node.dataset.filterMenuPositioned !== "true")
      node.dataset.filterMenuPositioned = "true";
  };
  const schedule = () => {
    if (node.open && frame === null) frame = win.requestAnimationFrame(update);
  };
  const onScroll = (event: Event) => {
    // Scrolling the panel's choices must not reset or reposition that scroller.
    if (event.target instanceof win.Node && panel.contains(event.target)) return;
    schedule();
  };
  // Observe only the anchor: writes to panel dimensions cannot trigger this observer.
  const observer = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  observer?.observe(anchor);
  node.addEventListener("toggle", update);
  doc.addEventListener("scroll", onScroll, true);
  win.addEventListener("resize", schedule, { passive: true });
  win.visualViewport?.addEventListener("resize", schedule, { passive: true });
  win.visualViewport?.addEventListener("scroll", schedule, { passive: true });

  return {
    node,
    update,
    dispose() {
      cancelFrame();
      observer?.disconnect();
      node.removeEventListener("toggle", update);
      doc.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", schedule);
      win.visualViewport?.removeEventListener("resize", schedule);
      win.visualViewport?.removeEventListener("scroll", schedule);
      for (const property of positionProperties) panel.style.removeProperty(property);
      node.removeAttribute("data-filter-menu-positioned");
      node.removeAttribute("data-filter-menu-side");
    },
  };
}

export function useFilterMenuPosition(ref: RefObject<HTMLDetailsElement | null>) {
  const binding = useRef<FilterMenuBinding | null>(null);
  // The native details mounts after auth/loading and when returning to Sites.
  // Check the ref every commit, retaining its binding and scroll position on rerenders.
  useLayoutEffect(() => {
    if (binding.current?.node !== ref.current) {
      binding.current?.dispose();
      binding.current = ref.current ? bindFilterMenu(ref.current) : null;
    }
    binding.current?.update();
  });
  useLayoutEffect(() => () => {
    binding.current?.dispose();
    binding.current = null;
  }, []);
}
