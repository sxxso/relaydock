import {
  compareMapOrder,
  type Island,
  type MapLayoutAccount,
  type MapNode,
} from "./map-layout";
export type MapPoint = { x: number; y: number };
export type MapMove = { id: string; group: string; beforeId: string | null };
export type MapDrop = Omit<MapMove, "id"> & { island: Island; cue: MapPoint };
export function createMapClickGuard() {
  let suppress = false;
  return {
    beginPointer() {
      suppress = false;
    },
    endPointer() {
      suppress = true;
    },
    // No timeout: a cancelled pointer may remain held indefinitely. Keyboard/AT clicks bypass it.
    allowsClick(detail: number) {
      return detail === 0 || !suppress;
    },
  };
}
export function movableMapNodes(
  nodes: readonly MapNode[],
  accounts: readonly MapLayoutAccount[],
  scopeIds: ReadonlySet<string>,
) {
  // Scope, not search matches, defines reachable nodes; dimmed active nodes remain anchors.
  const ids = new Set(
    accounts.filter((a) => !a.archived && scopeIds.has(a.id)).map((a) => a.id),
  );
  return nodes.filter((n) => ids.has(n.id));
}
export function projectMapPoint(
  point: MapPoint,
  screen: { a: number; b: number; c: number; d: number; e: number; f: number },
  camera: { x: number; y: number; k: number },
  viewport?: { width: number; height: number },
): MapPoint | null {
  // SVG's screen CTM includes CSS scaling/letterboxing, but not the world camera.
  const determinant = screen.a * screen.d - screen.b * screen.c;
  if (!determinant || camera.k <= 0) return null;
  const dx = point.x - screen.e,
    dy = point.y - screen.f;
  const localX = (screen.d * dx - screen.c * dy) / determinant;
  const localY = (screen.a * dy - screen.b * dx) / determinant;
  if (
    viewport &&
    (!Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      localX < 0 ||
      localY < 0 ||
      localX >= viewport.width ||
      localY >= viewport.height)
  )
    return null;
  const x = (localX - camera.x) / camera.k;
  const y = (localY - camera.y) / camera.k;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
export function dragDistanceReached(start: MapPoint, point: MapPoint) {
  return Math.hypot(point.x - start.x, point.y - start.y) >= 6;
}
function spatialOrder(a: MapNode, b: MapNode) {
  return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}
export function findMapDrop(
  point: MapPoint,
  id: string,
  islands: readonly Island[],
  nodes: readonly MapNode[],
  collapsed: ReadonlySet<string> = new Set(),
): MapDrop | null {
  // Use the full stable island bounds (including corner grid slots), not the ink jitter.
  const island = islands.find(
    (i) =>
      point.x >= i.x &&
      point.x <= i.x + i.width &&
      point.y >= i.y &&
      point.y <= i.y + i.height,
  );
  if (!island) return null;
  const ordered = nodes
    .filter((n) => n.group === island.name && n.id !== id)
    .sort(spatialOrder);
  let before: MapNode | undefined;
  if (
    !collapsed.has(island.name) &&
    ordered.length &&
    point.y <= ordered.at(-1)!.y + 58
  ) {
    if (point.y < ordered[0].y - 58) before = ordered[0];
    else {
      const row = ordered.reduce((nearest, n) =>
        Math.abs(n.y - point.y) < Math.abs(nearest.y - point.y) ? n : nearest,
      ).y;
      before =
        ordered.find((n) => n.y === row && point.x < n.x) ||
        ordered.find((n) => n.y > row);
    }
  }
  const last = ordered.at(-1);
  return {
    island,
    group: island.name,
    beforeId: before?.id ?? null,
    cue:
      collapsed.has(island.name) || !last
        ? { x: island.x + island.width / 2, y: island.y + island.height / 2 }
        : before
          ? { x: before.x - 48, y: before.y }
          : { x: last.x + 48, y: last.y },
  };
}
export function isMapMove(
  id: string,
  move: Omit<MapMove, "id">,
  nodes: readonly MapNode[],
  fullActiveNodes: readonly MapNode[] = nodes,
) {
  const source = nodes.find((n) => n.id === id);
  if (!source || move.beforeId === id) return false;
  if (
    move.beforeId !== null &&
    !nodes.some((n) => n.id === move.beforeId && n.group === move.group)
  )
    return false;
  if (source.group !== move.group) return true;
  // Hidden active siblings still participate in the backend's canonical rank order.
  const ordered = fullActiveNodes
    .filter((n) => n.group === source.group)
    .sort(spatialOrder);
  return (
    (ordered[ordered.findIndex((n) => n.id === id) + 1]?.id ?? null) !==
    move.beforeId
  );
}
export function previewMapMove<T extends MapLayoutAccount>(
  accounts: T[],
  move: MapMove,
): T[] {
  const source = accounts.find((a) => a.id === move.id);
  if (!source || source.archived || move.beforeId === move.id) return accounts;
  const target = accounts
    .filter(
      (a) =>
        !a.archived && (a.group || "未分组") === move.group && a.id !== move.id,
    )
    .sort(compareMapOrder);
  const index =
    move.beforeId === null
      ? target.length
      : target.findIndex((a) => a.id === move.beforeId);
  if (index < 0) return accounts;
  target.splice(index, 0, { ...source, group: move.group });
  const ranks = new Map(target.map((a, i) => [a.id, i]));
  return accounts.map((a) =>
    ranks.has(a.id)
      ? { ...a, group: move.group, mapOrder: ranks.get(a.id)! }
      : a,
  );
}
