"use client";
import { useEffect, useMemo, useRef, useState, useId } from "react";
import { select } from "d3-selection";
import { dragEnable } from "d3-drag";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import "d3-transition";
import {
  Plus,
  Minus,
  Scan,
  Map as MapIcon,
  ChevronDown,
  ChevronRight,
  LocateFixed,
  FoldVertical,
  Grip,
  PenLine,
} from "lucide-react";
import type { Account } from "@/lib/validation";
import { groupColorStyle, type GroupColor } from "@/lib/group-colors";
import {
  layoutIslands,
  islandPath,
  islandHeader,
  islandTitle,
  groupColorIndex,
} from "@/lib/map-layout";
import {
  createMapClickGuard,
  dragDistanceReached,
  findMapDrop,
  isMapMove,
  movableMapNodes,
  previewMapMove,
  projectMapPoint,
  type MapMove,
  type MapPoint,
} from "@/lib/map-drag";
import { displayAmount, isLow } from "@/lib/money";
import { balanceFreshness } from "@/lib/balance-freshness";
import "./balance-freshness.css";
import { InkCanvas } from "./ink-canvas";
import { AtlasSelect } from "./atlas-select";
import {
  backgroundOptions,
  BackgroundGlyph,
  BackgroundPattern,
  type MapBackground,
} from "./map-background";
import "./map-background.css";
import {
  fitBounds,
  viewportBounds,
  minimumZoom,
  mapCameraAction,
  type MapCameraState,
} from "@/lib/map-management";
import { MapMinimap } from "./map-minimap";
import "./map-management.css";
import { groupDragPosition, type GroupPosition } from "@/lib/group-layout";
import { backgroundPatternFrame, patternSpec, type PatternDensity } from "@/lib/map-background-pattern";
import "./group-drag.css";
type NodeDrag = {
  pointerId: number;
  id: string;
  element: SVGGElement;
  start: MapPoint;
  offset: MapPoint;
  moved: boolean;
};
type GroupDrag = {
  pointerId: number;
  name: string;
  element: SVGGElement;
  start: MapPoint;
  origin: MapPoint;
  offset: MapPoint;
  position: MapPoint;
  nodes: { element: SVGGElement; x: number; y: number }[];
  moved: boolean;
};
export function AtlasMap({
  accounts,
  selected,
  onSelect,
  motion,
  freshnessNow,
  background = "dots",
  backgroundOpacity = 100,
  density = "standard",
  inkColor,
  inkOpacity,
  onBackgroundChange,
  appearanceBusy = false,
  matchingIds,
  scopeIds,
  filtering = false,
  collapsedGroups,
  onToggleGroup,
  onMove,
  moveDisabled = false,
  groupPositions = [],
  groupColors = [],
  onMoveGroup,
  focusVersion = 0,
  onRenameGroup,
}: {
  accounts: Account[];
  selected: string | null;
  onSelect: (id: string) => void;
  motion: boolean;
  freshnessNow: number;
  background?: MapBackground;
  backgroundOpacity?: number;
  density?: PatternDensity;
  inkColor?: string | null;
  inkOpacity?: number;
  onBackgroundChange?: (value: MapBackground) => void;
  appearanceBusy?: boolean;
  matchingIds: ReadonlySet<string>;
  scopeIds: ReadonlySet<string>;
  filtering?: boolean;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (name: string) => void;
  onMove?: (
    id: string,
    group: string,
    beforeId: string | null,
  ) => Promise<void>;
  moveDisabled?: boolean;
  groupPositions?: GroupPosition[];
  groupColors?: GroupColor[];
  onMoveGroup?: (name: string, position: MapPoint | null) => Promise<void>;
  focusVersion?: number;
  onRenameGroup?: (name: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null),
    world = useRef<SVGGElement>(null),
    pattern = useRef<SVGPatternElement>(null),
    behavior = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null),
    container = useRef<HTMLDivElement>(null),
    scaleLabel = useRef<HTMLSpanElement>(null),
    minimapViewport = useRef<SVGRectElement>(null),
    paintRef = useRef<() => void>(() => {}),
    transform = useRef(zoomIdentity),
    detailVisibility = useRef(true),
    nodeDrag = useRef<NodeDrag | null>(null),
    groupDrag = useRef<GroupDrag | null>(null),
    spaceHeld = useRef(false),
    handPan = useRef<{ pointerId: number; start: MapPoint; origin: typeof zoomIdentity; mode: "space" | "middle" } | null>(null),
    groupFrame = useRef(0),
    islandElements = useRef(new Map<string, SVGGElement>()),
    groupHandles = useRef(new Map<string, SVGGElement>()),
    ghostLayer = useRef<SVGGElement>(null),
    dropBoundary = useRef<SVGRectElement>(null),
    insertionCue = useRef<SVGPathElement>(null),
    insertionLabel = useRef<SVGTextElement>(null),
    nodeElements = useRef(new Map<string, SVGGElement>()),
    clickGuard = useRef(createMapClickGuard()),
    cameraActive = useRef(false),
    activity = useRef(false),
    moveBusy = useRef(false),
    mounted = useRef(true),
    cancelDragRef = useRef<() => void>(() => {}),
    movePanel = useRef<HTMLFormElement>(null),
    moveLauncher = useRef<HTMLButtonElement>(null),
    [pendingMove, setPendingMove] = useState<MapMove | null>(null),
    [pendingGroup, setPendingGroup] = useState<{
      name: string;
      position: MapPoint | null;
    } | null>(null),
    [moveEditor, setMoveEditor] = useState<MapMove | null>(null),
    [moveAnnouncement, setMoveAnnouncement] = useState(""),
    [detailed, setDetailed] = useState(true),
    [minimapOpen, setMinimapOpen] = useState(true),
    [size, setSize] = useState({ width: 800, height: 570 });
  const layoutAccounts = pendingMove
    ? previewMapMove(accounts, pendingMove)
    : accounts;
  const placedGroups = pendingGroup
    ? [
        ...groupPositions.filter((p) => p.name !== pendingGroup.name),
        ...(pendingGroup.position
          ? [{ name: pendingGroup.name, ...pendingGroup.position }]
          : []),
      ]
    : groupPositions;
  const placementKey = JSON.stringify(
    [...placedGroups].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const cameraState = useRef<MapCameraState | null>(null);
  const geometry = useMemo(
    () => layoutIslands(layoutAccounts, placedGroups),
    [
      JSON.stringify(
        layoutAccounts
          .map((a) => [a.id, a.group, a.mapOrder ?? 0])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ),
      placementKey,
    ],
  );
  const lookup = useMemo(
      () => new Map(accounts.map((a) => [a.id, a])),
      [accounts],
    ),
    filter = useId().replace(/:/g, "");
  const paintContext = useRef({ size, geometry, background, density });
  paintContext.current = { size, geometry, background, density };
  const scopeGroups = useMemo(() => {
    const result = new Map<string, { count: number; matches: number }>();
    for (const a of layoutAccounts)
      if (scopeIds.has(a.id)) {
        const key = a.group || "未分组",
          count = result.get(key) || { count: 0, matches: 0 };
        count.count++;
        if (matchingIds.has(a.id)) count.matches++;
        result.set(key, count);
      }
    return result;
  }, [layoutAccounts, scopeIds, matchingIds]);
  const islands = geometry.islands.filter((i) => scopeGroups.has(i.name));
  const movableNodes = useMemo(
    () => movableMapNodes(geometry.nodes, accounts, scopeIds),
    [geometry, accounts, scopeIds],
  );
  const activeNodes = useMemo(
    () =>
      movableMapNodes(
        geometry.nodes,
        accounts,
        new Set(accounts.map((a) => a.id)),
      ),
    [geometry, accounts],
  );
  const movableIds = new Set(movableNodes.map((n) => n.id));
  const dropGroups = new Set(movableNodes.map((n) => n.group));
  const dropIslands = islands.filter((i) => dropGroups.has(i.name));
  const nodeLookup = useMemo(
    () => new Map(geometry.nodes.map((n) => [n.id, n])),
    [geometry],
  );
  const focusIndex = useRef(0);
  const canMove = !!onMove && !moveDisabled && !pendingMove && !pendingGroup;
  const canMoveGroup =
    !!onMoveGroup && !moveDisabled && !pendingMove && !pendingGroup;
  const moveChoices = moveEditor
    ? movableNodes.filter(
        (n) => n.group === moveEditor.group && n.id !== moveEditor.id,
      )
    : [];
  const editorValid =
    !!moveEditor &&
    movableIds.has(moveEditor.id) &&
    dropIslands.some((i) => i.name === moveEditor.group) &&
    isMapMove(moveEditor.id, moveEditor, movableNodes, activeNodes);

  function syncActivity() {
    // Activity is decoration/gesture state, not node-tree render state. A
    // wheel idle/start pair must not reconcile hundreds of unchanged nodes.
    activity.current =
      mounted.current &&
      (cameraActive.current ||
        !!handPan.current ||
        !!nodeDrag.current ||
        !!groupDrag.current ||
        moveBusy.current);
    container.current?.setAttribute("data-panning", String(activity.current));
  }

  function pointerPoint(
    e: { clientX: number; clientY: number },
    clipToViewport = true,
  ) {
    const element = svg.current,
      matrix = element?.getScreenCTM();
    return matrix && element
      ? projectMapPoint(
          { x: e.clientX, y: e.clientY },
          matrix,
          transform.current,
          clipToViewport
            ? {
                width: element.width.baseVal.value,
                height: element.height.baseVal.value,
              }
            : undefined,
        )
      : null;
  }
  function clearHandPan() {
    const active = handPan.current;
    if (!active) return;
    handPan.current = null;
    clickGuard.current.endPointer();
    container.current?.removeAttribute("data-hand-pan");
    syncActivity();
    if (svg.current?.hasPointerCapture(active.pointerId))
      svg.current.releasePointerCapture(active.pointerId);
  }
  function beginHandPan(e: React.PointerEvent<SVGSVGElement>) {
    if (!e.isPrimary || nodeDrag.current || groupDrag.current || handPan.current ||
      !(e.button === 1 || (e.button === 0 && spaceHeld.current))) return;
    const matrix = e.currentTarget.getScreenCTM();
    const start = matrix && projectMapPoint({ x: e.clientX, y: e.clientY }, matrix, zoomIdentity);
    if (!start) return;
    e.preventDefault();
    e.stopPropagation();
    select(e.currentTarget).interrupt();
    handPan.current = { pointerId: e.pointerId, start, origin: transform.current, mode: e.button === 1 ? "middle" : "space" };
    clickGuard.current.endPointer();
    container.current?.setAttribute("data-hand-pan", "true");
    e.currentTarget.setPointerCapture(e.pointerId);
    syncActivity();
  }
  function updateHandPan(e: React.PointerEvent<SVGSVGElement>) {
    const active = handPan.current;
    if (!active || active.pointerId !== e.pointerId) return false;
    const matrix = e.currentTarget.getScreenCTM();
    const point = matrix && projectMapPoint({ x: e.clientX, y: e.clientY }, matrix, zoomIdentity);
    if (!point) return true;
    e.preventDefault();
    moveCamera(zoomIdentity.translate(active.origin.x + point.x - active.start.x,
      active.origin.y + point.y - active.start.y).scale(active.origin.k), false);
    return true;
  }
  function clearNodeDrag() {
    const active = nodeDrag.current;
    if (!active) return;
    nodeDrag.current = null;
    syncActivity();
    clickGuard.current.endPointer();
    active.element.removeAttribute("data-drag-source");
    ghostLayer.current?.replaceChildren();
    dropBoundary.current?.setAttribute("visibility", "hidden");
    insertionCue.current?.setAttribute("visibility", "hidden");
    insertionLabel.current?.setAttribute("visibility", "hidden");
    container.current?.removeAttribute("data-node-dragging");
    container.current?.setAttribute("data-dragging", "false");
    container.current?.removeAttribute("data-drop-group");
    if (svg.current?.hasPointerCapture(active.pointerId))
      svg.current.releasePointerCapture(active.pointerId);
  }
  cancelDragRef.current = () => {
    clearHandPan();
    clearNodeDrag();
    clearGroupDrag();
  };

  function paintGroupDrag() {
    groupFrame.current = 0;
    const active = groupDrag.current;
    if (!active?.moved) return;
    const dx = active.position.x - active.origin.x,
      dy = active.position.y - active.origin.y;
    active.element.setAttribute("transform", `translate(${dx},${dy})`);
    for (const n of active.nodes)
      n.element.setAttribute("transform", `translate(${n.x + dx},${n.y + dy})`);
  }
  function clearGroupDrag() {
    const active = groupDrag.current;
    if (!active) return;
    cancelAnimationFrame(groupFrame.current);
    groupFrame.current = 0;
    groupDrag.current = null;
    active.element.removeAttribute("transform");
    active.element.removeAttribute("data-group-moving");
    for (const n of active.nodes)
      n.element.setAttribute("transform", `translate(${n.x},${n.y})`);
    container.current?.removeAttribute("data-group-dragging");
    container.current?.setAttribute("data-dragging", "false");
    clickGuard.current.endPointer();
    syncActivity();
    if (svg.current?.hasPointerCapture(active.pointerId))
      svg.current.releasePointerCapture(active.pointerId);
  }
  function beginGroupDrag(e: React.PointerEvent<SVGGElement>, name: string) {
    if (
      !canMoveGroup ||
      spaceHeld.current ||
      handPan.current ||
      moveBusy.current ||
      nodeDrag.current ||
      groupDrag.current ||
      e.button !== 0 ||
      !e.isPrimary ||
      e.ctrlKey
    )
      return;
    const point = pointerPoint(e),
      island = geometry.islands.find((i) => i.name === name),
      element = islandElements.current.get(name);
    if (!point || !island || !element || !svg.current) return;
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.removeAllRanges();
    select(svg.current).interrupt();
    paintRef.current();
    groupDrag.current = {
      pointerId: e.pointerId,
      name,
      element,
      start: { x: e.clientX, y: e.clientY },
      origin: { x: island.x, y: island.y },
      offset: { x: island.x - point.x, y: island.y - point.y },
      position: { x: island.x, y: island.y },
      moved: false,
      nodes: geometry.nodes
        .filter((n) => n.group === name)
        .flatMap((n) => {
          const el = nodeElements.current.get(n.id);
          return el ? [{ element: el, x: n.x, y: n.y }] : [];
        }),
    };
    syncActivity();
    svg.current.setPointerCapture(e.pointerId);
  }
  function updateGroupDrag(e: React.PointerEvent<SVGSVGElement>) {
    const active = groupDrag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    if (
      !active.moved &&
      !dragDistanceReached(active.start, { x: e.clientX, y: e.clientY })
    )
      return;
    e.preventDefault();
    const point = pointerPoint(e, false);
    if (!point) return;
    active.moved = true;
    active.position = groupDragPosition(point, active.offset);
    active.element.setAttribute("data-group-moving", "true");
    container.current?.setAttribute("data-group-dragging", active.name);
    container.current?.setAttribute("data-dragging", "true");
    if (!groupFrame.current)
      groupFrame.current = requestAnimationFrame(paintGroupDrag);
  }
  async function saveGroupPosition(name: string, position: MapPoint | null) {
    if (!canMoveGroup || !onMoveGroup || moveBusy.current) return;
    moveBusy.current = true;
    syncActivity();
    setPendingGroup({ name, position });
    setMoveAnnouncement("正在保存分组位置");
    try {
      await onMoveGroup(name, position);
      if (mounted.current)
        setMoveAnnouncement(position ? "分组位置已保存" : "分组已恢复自动布局");
    } catch {
      if (mounted.current) setMoveAnnouncement("分组移动未保存，已恢复原位置");
    } finally {
      moveBusy.current = false;
      syncActivity();
      if (mounted.current) setPendingGroup(null);
    }
  }
  function groupKey(e: React.KeyboardEvent<SVGGElement>, name: string) {
    if (!canMoveGroup || moveBusy.current) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const island = geometry.islands.find((i) => i.name === name);
      if (island) focusIsland(island);
      return;
    }
    if (
      e.key !== "Home" &&
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    const island = geometry.islands.find((i) => i.name === name);
    if (!island) return;
    const step = e.shiftKey ? 100 : 24;
    void saveGroupPosition(
      name,
      e.key === "Home"
        ? null
        : groupDragPosition(island, {
            x:
              e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
            y: e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0,
          }),
    );
  }

  function updateNodeDrag(e: React.PointerEvent<SVGSVGElement>) {
    const active = nodeDrag.current;
    if (!active || active.pointerId !== e.pointerId) return null;
    if (
      !active.moved &&
      !dragDistanceReached(active.start, { x: e.clientX, y: e.clientY })
    )
      return null;
    e.preventDefault();
    if (!active.moved) {
      active.moved = true;
      const ghost = active.element.cloneNode(true) as SVGGElement;
      for (const attr of [
        "data-node",
        "data-account-id",
        "role",
        "tabindex",
        "aria-pressed",
        "aria-label",
        "aria-describedby",
        "aria-keyshortcuts",
      ])
        ghost.removeAttribute(attr);
      ghost.classList.add("map-drag-ghost");
      ghost.setAttribute("aria-hidden", "true");
      ghostLayer.current?.replaceChildren(ghost);
      active.element.setAttribute("data-drag-source", "true");
      container.current?.setAttribute("data-node-dragging", "true");
      container.current?.setAttribute("data-dragging", "true");
    }
    const point = pointerPoint(e);
    const ghostPoint = point ?? pointerPoint(e, false);
    const ghost = ghostLayer.current?.firstElementChild;
    if (ghostPoint)
      ghost?.setAttribute(
        "transform",
        `translate(${ghostPoint.x + active.offset.x},${ghostPoint.y + active.offset.y})`,
      );
    const target = point
      ? findMapDrop(
          point,
          active.id,
          dropIslands,
          movableNodes,
          collapsedGroups,
        )
      : null;
    ghost?.setAttribute("data-valid-drop", String(!!target));
    for (const el of [
      dropBoundary.current,
      insertionCue.current,
      insertionLabel.current,
    ])
      el?.setAttribute("visibility", target ? "visible" : "hidden");
    if (target) {
      container.current?.setAttribute("data-drop-group", target.group);
      for (const key of ["x", "y", "width", "height"] as const)
        dropBoundary.current?.setAttribute(key, String(target.island[key]));
      insertionCue.current?.setAttribute(
        "d",
        `M${target.cue.x} ${target.cue.y - 32}v108m-5 -108h10m-10 108h10`,
      );
      insertionLabel.current?.setAttribute("x", String(target.cue.x));
      insertionLabel.current?.setAttribute("y", String(target.cue.y - 42));
      if (insertionLabel.current)
        insertionLabel.current.textContent = target.beforeId
          ? "插入此处"
          : "追加到末尾";
    } else container.current?.removeAttribute("data-drop-group");
    return target;
  }
  function beginNodeDrag(e: React.PointerEvent<SVGGElement>, id: string) {
    if (
      !canMove ||
      !movableIds.has(id) ||
      moveBusy.current ||
      nodeDrag.current ||
      groupDrag.current ||
      e.button !== 0 ||
      !e.isPrimary ||
      e.ctrlKey
    )
      return;
    const point = pointerPoint(e),
      node = nodeLookup.get(id);
    if (!point || !node || !svg.current) return;
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.removeAllRanges();
    select(svg.current).interrupt();
    paintRef.current();
    nodeDrag.current = {
      pointerId: e.pointerId,
      id,
      element: e.currentTarget,
      start: { x: e.clientX, y: e.clientY },
      offset: { x: node.x - point.x, y: node.y - point.y },
      moved: false,
    };
    syncActivity();
    svg.current.setPointerCapture(e.pointerId);
  }
  async function saveMove(move: MapMove) {
    if (
      !onMove ||
      moveDisabled ||
      moveBusy.current ||
      !isMapMove(move.id, move, movableNodes, activeNodes)
    )
      return;
    moveBusy.current = true;
    syncActivity();
    setPendingMove(move);
    setMoveEditor(null);
    setMoveAnnouncement("正在保存站点位置");
    try {
      // Parent must reject on failure and publish the canonical accounts before resolving.
      await onMove(move.id, move.group, move.beforeId);
      if (mounted.current) setMoveAnnouncement("站点位置已保存");
    } catch {
      // No persistence or error toast here: parent owns both. Clearing the preview rolls back.
      if (mounted.current) setMoveAnnouncement("移动未保存，已恢复原位置");
    } finally {
      moveBusy.current = false;
      syncActivity();
      if (mounted.current) setPendingMove(null);
    }
  }
  function openMoveEditor(id: string) {
    if (!canMove || moveBusy.current || !movableIds.has(id)) return;
    const node = nodeLookup.get(id);
    if (!node) return;
    clearNodeDrag();
    const ordered = movableNodes.filter((n) => n.group === node.group);
    const beforeId =
      ordered[ordered.findIndex((n) => n.id === id) + 1]?.id ?? null;
    setMoveEditor({ id, group: node.group, beforeId });
  }
  function closeMoveEditor() {
    const id = moveEditor?.id;
    setMoveEditor(null);
    (id ? nodeElements.current.get(id) : undefined)?.focus();
  }
  useEffect(() => {
    mounted.current = true;
    const escape = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      // Preserve Space activation on focused buttons and inputs. On the canvas
      // or document background, hold Space to grab from anywhere in the SVG.
      if (e.code === "Space" && (target === document.body || target === svg.current)) {
        e.preventDefault();
        spaceHeld.current = true;
        svg.current?.setAttribute("data-space-pan", "true");
      }
      if (e.key === "Escape" && (nodeDrag.current || groupDrag.current || handPan.current)) {
        e.preventDefault();
        cancelDragRef.current();
      }
    };
    const release = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spaceHeld.current = false;
      svg.current?.removeAttribute("data-space-pan");
      if (handPan.current?.mode === "space") clearHandPan();
    };
    const blur = () => {
      spaceHeld.current = false;
      svg.current?.removeAttribute("data-space-pan");
      cancelDragRef.current();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      cancelDragRef.current();
      syncActivity();
      window.removeEventListener("keydown", escape);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
      spaceHeld.current = false;
    };
  }, []);
  useEffect(() => {
    movePanel.current
      ?.querySelector<HTMLButtonElement>('[aria-label="移动目标分组"]')
      ?.focus();
  }, [moveEditor?.id]);
  useEffect(() => {
    // A changed layout, scope, folding, or disabled state invalidates a captured drag.
    cancelDragRef.current();
  }, [
    geometry,
    scopeIds,
    collapsedGroups,
    moveDisabled,
    !!onMove,
    !!onMoveGroup,
  ]);
  const duration = (ms: number) =>
    motion &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches &&
    !matchMedia("(pointer: coarse)").matches
      ? ms
      : 0;
  const ease = (t: number) => 1 - Math.pow(1 - t, 4);
  const fit = () => {
    if (!svg.current || !behavior.current) return;
    const camera = fitBounds(geometry, size);
    const t = zoomIdentity.translate(camera.x, camera.y).scale(camera.k);
    select(svg.current)
      .interrupt()
      .transition()
      .duration(duration(300))
      .ease(ease)
      .call(behavior.current.transform, t);
  };
  useEffect(() => {
    let el = container.current;
    if (!el) return;
    let observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!svg.current || !world.current) return;
    const element = svg.current;
    let frame = 0;
    let alive = true;
    let mouseActive = false;
    let activeGestures = 0;
    let lastPercent = -1;
    const paint = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!alive) return;
      const t = transform.current;
      world.current?.setAttribute("transform", t.toString());
      const {
        size: viewport,
        geometry: bounds,
        background: kind,
        density: textureDensity,
      } = paintContext.current;
      const sampling = backgroundPatternFrame(kind, textureDensity, t);
      pattern.current?.setAttribute(
        "patternTransform",
        `translate(${sampling.x},${sampling.y}) scale(${sampling.scale})`,
      );
      container.current?.setAttribute(
        "data-grid-spacing",
        sampling.screenSpacing.toFixed(2),
      );
      const v = viewportBounds(t, viewport, bounds);
      for (const key of ["x", "y", "width", "height"] as const)
        minimapViewport.current?.setAttribute(key, String(v[key]));
      const percent = Math.round(t.k * 100);
      if (lastPercent !== percent && scaleLabel.current) {
        scaleLabel.current.textContent = percent + "%";
        lastPercent = percent;
      }
      // Only the detail threshold can render the node tree, never each gesture frame.
      const nextDetail = t.k > 0.5;
      if (nextDetail !== detailVisibility.current) {
        detailVisibility.current = nextDetail;
        setDetailed(nextDetail);
      }
    };
    let z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([minimumZoom(geometry, size), 2.5])
      .clickDistance(5)
      .filter(
        (e) =>
          !nodeDrag.current &&
          !groupDrag.current &&
          !handPan.current &&
          !spaceHeld.current &&
          !e.button &&
          (!e.ctrlKey || e.type === "wheel") &&
          (e.type === "wheel" ||
            !(e.target as Element).closest("[data-node],[data-map-control]")),
      )
      .interpolate((a, b) => (t) => [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ])
      .on("start", (e) => {
        if (!alive) return;
        activeGestures++;
        if (e.sourceEvent?.type === "mousedown") mouseActive = true;
        cameraActive.current = true;
        syncActivity();
      })
      .on("end", (e) => {
        if (!alive) return;
        activeGestures = Math.max(0, activeGestures - 1);
        // An older wheel idle event must not end a newer held mouse gesture.
        if (e.sourceEvent?.type === "mouseup") mouseActive = false;
        cancelAnimationFrame(frame);
        paint();
        cameraActive.current = mouseActive || activeGestures > 0;
        syncActivity();
      })
      .on("zoom", (e) => {
        if (!alive) return;
        transform.current = e.transform;
        if (!frame) frame = requestAnimationFrame(paint);
      });
    behavior.current = z;
    paintRef.current = paint;
    select(element).call(z).on("dblclick.zoom", null);
    return () => {
      alive = false;
      select(element).interrupt().on(".zoom", null);
      cancelAnimationFrame(frame);
      if (mouseActive) {
        select(window).on("mousemove.zoom", null).on("mouseup.zoom", null);
        dragEnable(window, false);
      }
      behavior.current = null;
      paintRef.current = () => {};
      cameraActive.current = false;
      syncActivity();
    };
  }, []);
  useEffect(() => {
    behavior.current?.scaleExtent([minimumZoom(geometry, size), 2.5]);
    paintRef.current();
  }, [size, geometry, background, density, minimapOpen]);
  useEffect(() => {
    const next: MapCameraState = {
      selected,
      version: focusVersion,
      width: size.width,
      height: size.height,
      hasTarget: !!selected && nodeLookup.has(selected),
      waiting: !!pendingMove || !!pendingGroup,
    };
    const action = mapCameraAction(cameraState.current, next);
    // Do not consume a request while its optimistic layout is being committed.
    if (action === "wait") return;
    cameraState.current = next;
    if (action === "fit") fit();
    else if (action === "focus" && selected) focusNode(selected);
  }, [
    selected,
    focusVersion,
    geometry,
    size.width,
    size.height,
    pendingMove,
    pendingGroup,
  ]);
  function focusNode(id: string) {
    if (!svg.current || !behavior.current) return;
    const node = nodeLookup.get(id);
    if (!node) return;
    let k = Math.min(Math.max(transform.current.k, 0.82), 1.25),
      t = zoomIdentity
        .translate(size.width / 2 - node.x * k, size.height / 2 - node.y * k)
        .scale(k);
    select(svg.current)
      .interrupt()
      .transition()
      .duration(duration(300))
      .ease(ease)
      .call(behavior.current.transform, t);
  }
  function focusIsland(island: (typeof geometry.islands)[number]) {
    const camera = fitBounds(island, size);
    moveCamera(
      zoomIdentity.translate(camera.x, camera.y).scale(camera.k),
      true,
    );
  }
  function moveCamera(t: typeof zoomIdentity, animate: boolean) {
    if (!svg.current || !behavior.current) return;
    const selection = select(svg.current).interrupt();
    if (animate && duration(300))
      selection
        .transition()
        .duration(duration(300))
        .ease(ease)
        .call(behavior.current.transform, t);
    else selection.call(behavior.current.transform, t);
  }
  function focusNext() {
    const ids = [...matchingIds];
    if (!ids.length) return;
    const id = ids[focusIndex.current++ % ids.length];
    onSelect(id);
    focusNode(id);
  }
  function changeScale(factor: number) {
    if (svg.current && behavior.current)
      select(svg.current)
        .interrupt()
        .transition()
        .duration(duration(180))
        .ease(ease)
        .call(behavior.current.scaleBy, factor);
  }
  return (
    <div
      ref={container}
      className={"atlas-map " + (!motion ? "no-motion" : "")}
      data-testid="atlas-map"
      data-panning="false"
      data-background={background}
      data-background-density={density}
      data-move-pending={!!pendingMove || !!pendingGroup}
      data-dragging="false"
      onPointerDownCapture={(e) => {
        // Reset only for a new intentional pointer activation, never by elapsed time.
        if (
          e.isPrimary &&
          e.button === 0 &&
          !nodeDrag.current &&
          !groupDrag.current
        )
          clickGuard.current.beginPointer();
        // d3 suppresses native selection clearing. Only clear on the map, not inputs or document text.
        if (
          e.button === 0 &&
          !(e.target as Element).closest(
            "button,input,select,[data-node],[data-map-control]",
          )
        )
          window.getSelection()?.removeAllRanges();
      }}
    >
      <InkCanvas enabled={motion} activityRef={activity} color={inkColor} opacity={inkOpacity} />
      <svg
        ref={svg}
        role="group"
        aria-label="按分组展示的站点群岛，可缩放与平移"
        tabIndex={0}
        aria-describedby={`map-pan-help-${filter}`}
        className="atlas-svg"
        width={size.width}
        height={size.height}
        onPointerDownCapture={beginHandPan}
        onClickCapture={(e) => {
          if (!clickGuard.current.allowsClick(e.detail)) e.stopPropagation();
        }}
        onPointerMove={(e) => {
          if (updateHandPan(e)) return;
          updateNodeDrag(e);
          updateGroupDrag(e);
        }}
        onPointerUp={(e) => {
          if (handPan.current?.pointerId === e.pointerId) {
            updateHandPan(e);
            clearHandPan();
            return;
          }
          const draggedGroup = groupDrag.current;
          if (draggedGroup?.pointerId === e.pointerId) {
            updateGroupDrag(e);
            const valid = !!pointerPoint(e);
            clearGroupDrag();
            if (draggedGroup.moved && valid)
              void saveGroupPosition(draggedGroup.name, draggedGroup.position);
            else if (!draggedGroup.moved && valid) {
              const island = geometry.islands.find(
                (i) => i.name === draggedGroup.name,
              );
              if (island) focusIsland(island);
            }
            return;
          }
          const active = nodeDrag.current;
          if (!active || active.pointerId !== e.pointerId) return;
          const target = updateNodeDrag(e);
          clearNodeDrag();
          if (active.moved) {
            if (target)
              void saveMove({
                id: active.id,
                group: target.group,
                beforeId: target.beforeId,
              });
          } else if (pointerPoint(e)) onSelect(active.id);
        }}
        onPointerCancel={(e) => {
          if (handPan.current?.pointerId === e.pointerId) clearHandPan();
          if (nodeDrag.current?.pointerId === e.pointerId) clearNodeDrag();
          if (groupDrag.current?.pointerId === e.pointerId) clearGroupDrag();
        }}
        onLostPointerCapture={(e) => {
          if (handPan.current?.pointerId === e.pointerId) clearHandPan();
          if (nodeDrag.current?.pointerId === e.pointerId) clearNodeDrag();
          if (groupDrag.current?.pointerId === e.pointerId) clearGroupDrag();
        }}
      >
        <defs>
          <pattern
            ref={pattern}
            id={"grid-" + filter}
            patternUnits="userSpaceOnUse"
            width={patternSpec(background).width}
            height={patternSpec(background).height}
          >
            <BackgroundPattern kind={background} />
          </pattern>
          <filter id={filter} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency=".018 .026"
              numOctaves="2"
              seed="9"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="7"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
        <rect
          className="map-pattern-plane"
          width="100%"
          height="100%"
          fill={`url(#grid-${filter})`}
          opacity={Number.isFinite(backgroundOpacity) ? Math.max(0, Math.min(100, backgroundOpacity)) / 100 : 1}
          pointerEvents="none"
        />
        <g ref={world} data-testid="map-world">
          {islands.map((island, i) => {
            const header = islandHeader(island),
              center = island.x + island.width / 2;
            return (
              <g
                className={"ink-island group-color-" + groupColorIndex(island.name)}
                key={island.name}
                ref={(element) => {
                  if (element) islandElements.current.set(island.name, element);
                  else islandElements.current.delete(island.name);
                }}
                data-island-group={island.name}
                role="group"
                aria-label={`分组 ${island.name}`}
                style={
                  {
                    "--island-delay": `${Math.min(i * 35, 140)}ms`,
                    ...groupColorStyle(island.name, groupColors),
                  } as React.CSSProperties
                }
              >
                <path
                  d={islandPath(island)}
                  className={"island-wash island-" + groupColorIndex(island.name)}
                  filter={`url(#${filter})`}
                />
                <ellipse
                  cx={island.x + island.width / 2}
                  cy={island.y + island.height / 2}
                  rx={island.width * 0.445}
                  ry={island.height * 0.435}
                  fill="none"
                  className={"island-ring island-" + groupColorIndex(island.name)}
                  strokeWidth="7"
                  strokeDasharray={`${island.width * 0.65} 32 ${island.width * 0.7} 60`}
                  transform={`rotate(-9 ${island.x + island.width / 2} ${island.y + island.height / 2})`}
                  filter={`url(#${filter})`}
                />
                <title>{island.name}</title>
                <defs>
                  <clipPath id={`island-title-${filter}-${i}`}>
                    <rect
                      x={header.x}
                      y={header.y}
                      width={header.width}
                      height={header.height}
                    />
                  </clipPath>
                </defs>
                <g
                  ref={(element) => {
                    if (element) groupHandles.current.set(island.name, element);
                    else groupHandles.current.delete(island.name);
                  }}
                  data-group-handle={island.name}
                  data-map-control="true"
                  role="button"
                  tabIndex={0}
                  aria-label={`移动分组 ${island.name}`}
                  aria-disabled={!canMoveGroup}
                  aria-describedby={`group-drag-help-${filter}`}
                  aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home"
                  className={
                    "island-drag-handle " + (canMoveGroup ? "is-movable" : "")
                  }
                  onPointerDown={(e) => beginGroupDrag(e, island.name)}
                  onClick={(e) => {
                    if (
                      !groupDrag.current &&
                      clickGuard.current.allowsClick(e.detail)
                    )
                      focusIsland(island);
                  }}
                  onKeyDown={(e) => groupKey(e, island.name)}
                >
                  <title>
                    拖动移动整组；方向键微调，Shift 加大步长，Home 恢复自动布局
                  </title>
                  <rect
                    x={header.x - 10}
                    y={header.y - 4}
                    width={header.width + 20}
                    height={header.height + 8}
                    rx="8"
                  />
                  <Grip
                    x={header.x + 2}
                    y={header.y + 9}
                    size={18}
                    className="group-grip"
                  />
                  <text
                    x={center}
                    y={header.y + 25}
                    textAnchor="middle"
                    data-group-title={island.name}
                    className="island-title"
                    aria-label={island.name}
                    clipPath={`url(#island-title-${filter}-${i})`}
                  >
                    <title>{island.name}</title>
                    {islandTitle(island.name, header.width - 48)}
                  </text>
                </g>
                <g
                  className="island-header-controls"
                  transform={`translate(${center},${header.controlsY + 14})`}
                >
                  <g
                    role="button"
                    tabIndex={0}
                    data-map-control="true"
                    className="island-header-action"
                    transform="translate(-82,0)"
                    aria-label={`${collapsedGroups.has(island.name) ? "展开" : "折叠"}分组 ${island.name}`}
                    aria-expanded={!collapsedGroups.has(island.name)}
                    onClick={() => onToggleGroup(island.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleGroup(island.name);
                      }
                    }}
                  >
                    <circle r="14" />
                    {collapsedGroups.has(island.name) ? (
                      <ChevronRight x={-8} y={-8} size={16} />
                    ) : (
                      <ChevronDown x={-8} y={-8} size={16} />
                    )}
                  </g>
                  <text y="4" textAnchor="middle" className="island-count">
                    {filtering
                      ? `${scopeGroups.get(island.name)!.matches} / ${scopeGroups.get(island.name)!.count}`
                      : scopeGroups.get(island.name)!.count}{" "}
                    个账号
                  </text>
                  <g
                    role="button"
                    tabIndex={0}
                    data-map-control="true"
                    className="island-header-action"
                    transform="translate(82,0)"
                    aria-label={`聚焦分组 ${island.name}`}
                    onClick={() => focusIsland(island)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        focusIsland(island);
                      }
                    }}
                  >
                    <circle r="14" />
                    <LocateFixed x={-8} y={-8} size={16} />
                  </g>
                  {onRenameGroup && (
                    <g
                      role="button"
                      tabIndex={moveDisabled ? -1 : 0}
                      data-map-control="true"
                      className="island-header-action"
                      transform="translate(116,0)"
                      aria-label={`改名分组 ${island.name}`}
                      aria-disabled={moveDisabled}
                      onClick={() => {
                        if (!moveDisabled) onRenameGroup(island.name);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!moveDisabled) onRenameGroup(island.name);
                        }
                      }}
                    >
                      <title>改名分组</title>
                      <circle r="13" />
                      <PenLine x={-7} y={-7} size={14} />
                    </g>
                  )}
                </g>
                {collapsedGroups.has(island.name) && (
                  <g
                    role="button"
                    tabIndex={0}
                    className="collapsed-island"
                    data-map-control="true"
                    aria-label={`展开分组 ${island.name}`}
                    aria-expanded={false}
                    onClick={() => onToggleGroup(island.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggleGroup(island.name);
                      }
                    }}
                  >
                    <rect
                      x={island.x + island.width / 2 - 82}
                      y={island.y + island.height / 2 - 28}
                      width="164"
                      height="56"
                      rx="28"
                    />
                    <text
                      x={island.x + island.width / 2}
                      y={island.y + island.height / 2 + 5}
                      textAnchor="middle"
                    >
                      {scopeGroups.get(island.name)!.count} 个账号 · 点击展开
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {geometry.nodes.map((node) => {
            let a = lookup.get(node.id)!;
            if (!scopeIds.has(a.id) || collapsedGroups.has(node.group))
              return null;
            const matched = matchingIds.has(a.id);
            const freshness = balanceFreshness(a, freshnessNow);
            const nameCharacters = Array.from(a.name),
              nameLimit = /[^\x00-\xff]/.test(a.name) ? 7 : 13;
            const nodeName =
              nameCharacters.length > nameLimit
                ? nameCharacters.slice(0, nameLimit - 1).join("") + "…"
                : a.name;
            return (
              <g
                key={a.id}
                ref={(element) => {
                  if (element) nodeElements.current.set(a.id, element);
                  else nodeElements.current.delete(a.id);
                }}
                transform={`translate(${node.x},${node.y})`}
                data-node="true"
                data-account-id={a.id}
                style={groupColorStyle(node.group, groupColors)}
                data-match={matched}
                role="button"
                tabIndex={matched || selected === a.id ? 0 : -1}
                aria-label={`${a.name} ${a.alias}，${displayAmount(a.balance, a.balanceUnit)} ${a.balanceUnit}，${freshness.accessibleLabel}`}
                aria-pressed={selected === a.id}
                aria-describedby={
                  onMove && movableIds.has(a.id)
                    ? `map-move-help-${filter}`
                    : undefined
                }
                aria-keyshortcuts={
                  onMove && movableIds.has(a.id) ? "Alt+M" : undefined
                }
                onPointerDown={(e) => beginNodeDrag(e, a.id)}
                onClick={(e) => {
                  if (
                    !nodeDrag.current &&
                    !groupDrag.current &&
                    clickGuard.current.allowsClick(e.detail)
                  )
                    onSelect(a.id);
                }}
                onKeyDown={(e) => {
                  if (e.altKey && e.key.toLowerCase() === "m" && onMove) {
                    e.preventDefault();
                    e.stopPropagation();
                    openMoveEditor(a.id);
                  } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(a.id);
                  }
                }}
                className={
                  "map-node group-color-" + groupColorIndex(node.group) + " " +
                  (canMove && movableIds.has(a.id) ? "is-movable " : "") +
                  (filtering && !matched ? "is-dimmed " : "") +
                  (selected === a.id ? "is-selected " : "") +
                  (isLow(a) ? "is-low" : "")
                }
              >
                <title>
                  {a.name} {a.alias} · {freshness.accessibleLabel}
                </title>
                <circle r="32" className="node-halo" />
                <circle r="25" className="node-core" />
                <text y="7" textAnchor="middle" className="node-initial">
                  {Array.from(a.name)[0]}
                </text>
                {a.favorite && (
                  <text x="29" y="-19" className="node-star">
                    ✦
                  </text>
                )}
                <text y="44" textAnchor="middle" className="node-name">
                  {nodeName}
                </text>
                {detailed && (
                  <text y="61" textAnchor="middle" className="node-balance">
                    {displayAmount(a.balance, a.balanceUnit)}
                    {!["USD", "CNY"].includes(a.balanceUnit)
                      ? " " + a.balanceUnit
                      : ""}
                  </text>
                )}
                {detailed && (
                  <text
                    y="76"
                    textAnchor="middle"
                    className={
                      "node-freshness" +
                      (freshness.queryFailed || freshness.testFailed
                        ? " has-error"
                        : "")
                    }
                  >
                    {freshness.mapLabel}
                  </text>
                )}
                {isLow(a) && (
                  <circle cx="26" cy="-23" r="5" className="node-warning" />
                )}
              </g>
            );
          })}
          <g
            aria-hidden="true"
            pointerEvents="none"
            className="map-drop-overlay"
          >
            <rect
              ref={dropBoundary}
              className="map-drop-boundary"
              rx="22"
              visibility="hidden"
            />
            <path
              ref={insertionCue}
              className="map-insertion-cue"
              visibility="hidden"
            />
            <text
              ref={insertionLabel}
              className="map-insertion-label"
              textAnchor="middle"
              visibility="hidden"
            />
          </g>
          <g ref={ghostLayer} aria-hidden="true" pointerEvents="none" />
        </g>
      </svg>
      {onMove && (
        <>
          <span id={`map-move-help-${filter}`} className="map-sr-only">
            拖动可调整顺序或移动分组。按 Alt+M
            打开移动控件，选择目标分组与插入位置；Escape 取消。
          </span>
          <span className="map-sr-only" role="status" aria-live="polite">
            {moveAnnouncement}
          </span>
          <button
            ref={moveLauncher}
            className="map-move-launcher"
            data-testid="map-move-selected"
            disabled={!canMove || !selected || !movableIds.has(selected)}
            onClick={() => {
              if (selected) openMoveEditor(selected);
            }}
          >
            {pendingMove ? "正在保存位置…" : "移动所选站点"}
          </button>
          {moveEditor && (
            <form
              ref={movePanel}
              className="map-move-panel"
              data-testid="map-move-panel"
              aria-labelledby={`map-move-title-${filter}`}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeMoveEditor();
                }
              }}
              onSubmit={(e) => {
                e.preventDefault();
                if (editorValid) {
                  void saveMove(moveEditor);
                  moveLauncher.current?.focus();
                }
              }}
            >
              <strong id={`map-move-title-${filter}`}>
                移动 {lookup.get(moveEditor.id)?.name}
              </strong>
              <label htmlFor={`map-move-group-${filter}`}>
                目标分组
                <AtlasSelect
                  id={`map-move-group-${filter}`}
                  label="移动目标分组"
                  className="map-move-select"
                  value={moveEditor.group}
                  disabled={!canMove}
                  onValueChange={(group) =>
                    setMoveEditor({
                      ...moveEditor,
                      group,
                      beforeId: null,
                    })
                  }
                  options={dropIslands.map((i) => ({
                    value: i.name,
                    label: i.name,
                    description: `${movableNodes.filter((n) => n.group === i.name).length} 个可见使用中账号${collapsedGroups.has(i.name) ? " · 分组已折叠" : ""}`,
                  }))}
                />
              </label>
              <label htmlFor={`map-move-position-${filter}`}>
                插入位置
                <AtlasSelect
                  id={`map-move-position-${filter}`}
                  label="移动插入位置"
                  className="map-move-select"
                  value={moveEditor.beforeId ?? ""}
                  disabled={!canMove}
                  onValueChange={(beforeId) =>
                    setMoveEditor({
                      ...moveEditor,
                      beforeId: beforeId || null,
                    })
                  }
                  options={[
                    ...moveChoices.map((n) => ({
                      value: n.id,
                      label: `在 ${lookup.get(n.id)?.name} 之前`,
                      description:
                        lookup.get(n.id)?.alias ||
                        "插入此站点之前，其余站点保持顺序",
                    })),
                    {
                      value: "",
                      label: "分组末尾",
                      description: "追加到目标分组所有使用中账号之后",
                    },
                  ]}
                />
              </label>
              <small>选择其他位置后保存；Escape 取消。</small>
              <div>
                <button type="button" onClick={closeMoveEditor}>
                  取消移动
                </button>
                <button type="submit" disabled={!canMove || !editorValid}>
                  保存位置
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <details className="map-group-index">
        <summary>
          <FoldVertical size={14} />
          分组索引 <small>{islands.length}</small>
          <ChevronDown size={13} />
        </summary>
        <div className="map-group-items">
          {islands.map((island) => {
            const count = scopeGroups.get(island.name)!;
            return (
              <div className="map-group-row" key={island.name}>
                <button
                  aria-label={`聚焦分组 ${island.name}`}
                  onClick={() => focusIsland(island)}
                >
                  <span>{island.name}</span>
                  <small>
                    {filtering
                      ? `${count.matches} / ${count.count}`
                      : count.count}
                  </small>
                </button>
                <button
                  className="group-fold"
                  aria-label={`${collapsedGroups.has(island.name) ? "展开" : "折叠"}分组 ${island.name}`}
                  aria-expanded={!collapsedGroups.has(island.name)}
                  onClick={() => onToggleGroup(island.name)}
                >
                  {collapsedGroups.has(island.name) ? (
                    <ChevronRight size={15} />
                  ) : (
                    <ChevronDown size={15} />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </details>
      {filtering && (
        <div className="map-match-control" role="status">
          <span>
            {matchingIds.size
              ? `匹配 ${matchingIds.size} 个账号`
              : "没有匹配的账号"}
          </span>
          <button
            disabled={!matchingIds.size}
            aria-label="定位匹配站点"
            onClick={focusNext}
          >
            <LocateFixed size={14} />
            定位
          </button>
        </div>
      )}
      {onBackgroundChange && (
        <div className="map-style-control">
          <AtlasSelect
            label="地图背景"
            value={background}
            disabled={appearanceBusy}
            onValueChange={(value) =>
              onBackgroundChange(value as MapBackground)
            }
            options={backgroundOptions.map((p) => ({
              ...p,
              icon: <BackgroundGlyph kind={p.value} />,
            }))}
          />
        </div>
      )}
      <div className="map-controls">
        <button aria-label="缩小地图" onClick={() => changeScale(0.8)}>
          <Minus size={15} />
        </button>
        <span ref={scaleLabel}>100%</span>
        <button aria-label="放大地图" onClick={() => changeScale(1.25)}>
          <Plus size={15} />
        </button>
        <i />
        <button aria-label="显示全部站点" onClick={fit}>
          <Scan size={15} />
        </button>
        <button
          aria-label="定位小窗"
          aria-pressed={minimapOpen}
          onClick={() => setMinimapOpen((v) => !v)}
        >
          <MapIcon size={15} />
        </button>
      </div>
      {minimapOpen && (
        <MapMinimap
          islands={islands}
          groupColors={groupColors}
          size={geometry}
          viewport={viewportBounds(transform.current, size, geometry)}
          viewportRef={minimapViewport}
          selectedNode={selected ? nodeLookup.get(selected) : undefined}
          onFit={fit}
          onGroup={focusIsland}
          onPan={(x, y) => {
            const t = transform.current;
            moveCamera(
              zoomIdentity.translate(t.x + x, t.y + y).scale(t.k),
              false,
            );
          }}
          onLocate={(point, animate) => {
            const k = transform.current.k;
            moveCamera(
              zoomIdentity
                .translate(
                  size.width / 2 - point.x * k,
                  size.height / 2 - point.y * k,
                )
                .scale(k),
              animate,
            );
          }}
        />
      )}
      <span id={`group-drag-help-${filter}`} className="sr-only">
        拖动分组标题移动整组，松手保存；Esc
        取消。标题获得焦点后方向键移动，Shift 加大步长，Home 恢复自动布局，Enter
        聚焦。
      </span>
      <span id={`map-pan-help-${filter}`} className="sr-only">
        空白处拖动平移；画布获得焦点后按住空格拖动，或按住鼠标中键从任意位置平移。滚轮缩放，显示全部站点可回到群岛。
      </span>
      {!minimapOpen && <span className="map-caption">
        <MapIcon size={12} /> 分组即群岛 · 大小不代表余额
      </span>}
    </div>
  );
}
