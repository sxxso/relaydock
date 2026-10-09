import { isLow, unitKey } from "./money";
export type Bounds = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type WorldBounds = Size & Partial<Pick<Bounds, "x" | "y">>;
const worldOrigin = (world: WorldBounds) => ({ x: world.x ?? 0, y: world.y ?? 0 });
export type Camera = { x: number; y: number; k: number };
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));

/** Power-of-two sampling keeps world alignment while thinning a far-away grid. */
export function gridSampling(k: number, base = 32) {
  const scale = Number.isFinite(k) && k > 0 ? k : 1;
  const multiplier = 2 ** Math.ceil(Math.log2(24 / (base * scale)));
  return { multiplier, screenSpacing: base * scale * multiplier };
}
export function fitBounds(bounds: Bounds, viewport: Size): Camera {
  const k = Math.min(
    1.3,
    Math.max(1, viewport.width - 60) / Math.max(1, bounds.width),
    Math.max(1, viewport.height - 60) / Math.max(1, bounds.height),
  );
  return {
    k,
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * k,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * k,
  };
}
/** The wheel/button limit must allow the same full-world fit at every viewport. */
export function minimumZoom(world: WorldBounds, viewport: Size) {
  return Math.min(0.02, fitBounds({ ...world, ...worldOrigin(world) }, viewport).k);
}
export function viewportBounds(t: Camera, size: Size, world: WorldBounds): Bounds {
  const origin = worldOrigin(world);
  const x = clamp(-t.x / t.k, origin.x, origin.x + world.width),
    y = clamp(-t.y / t.k, origin.y, origin.y + world.height);
  const right = clamp((size.width - t.x) / t.k, origin.x, origin.x + world.width),
    bottom = clamp((size.height - t.y) / t.k, origin.y, origin.y + world.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}
/** Include letterboxing in the viewBox so pointer projection has no CSS guesses. */
export function overviewBounds(world: WorldBounds, aspect = 170 / 110): Bounds {
  const width = Math.max(world.width, world.height * aspect),
    height = width / aspect;
  return {
    x: (world.x ?? 0) + (world.width - width) / 2,
    y: (world.y ?? 0) + (world.height - height) / 2,
    width,
    height,
  };
}
export function overviewPoint(
  point: { x: number; y: number },
  size: Size,
  domain: Bounds,
  world: WorldBounds,
) {
  const origin = worldOrigin(world);
  return {
    x: clamp(domain.x + (point.x / size.width) * domain.width, origin.x, origin.x + world.width),
    y: clamp(
      domain.y + (point.y / size.height) * domain.height,
      origin.y,
      origin.y + world.height,
    ),
  };
}
export function retainVisibleSelection(
  selected: ReadonlySet<string>,
  visible: ReadonlySet<string>,
) {
  const next = new Set(
    [...selected].filter((id) => visible.has(id)).slice(0, 500),
  );
  return next.size === selected.size ? selected : next;
}
export function matchesSearch(
  a: {
    name: string;
    alias: string;
    siteUrl: string;
    group: string;
    tags: string[];
  },
  search: string,
) {
  return [a.name, a.alias, a.siteUrl, a.group, ...a.tags]
    .join(" ")
    .toLowerCase()
    .includes(search.trim().toLowerCase());
}
export function savedGroupNames(
  accounts: ReadonlyArray<{ group: string }>,
  current = "",
) {
  return [
    ...new Set([
      "未分组",
      ...accounts.map((a) => a.group.trim() || "未分组"),
      ...(current.trim() ? [current.trim()] : []),
    ]),
  ].sort((a, b) => a.localeCompare(b, "zh"));
}

export type MapCameraState = {
  selected: string | null;
  version: number;
  width: number;
  height: number;
  hasTarget: boolean;
  waiting?: boolean;
};
/** A data/geometry change alone is never a camera instruction. */
export function mapCameraAction(
  previous: MapCameraState | null,
  next: MapCameraState,
) {
  if (next.waiting || (next.selected && !next.hasTarget)) return "wait";
  if (!previous) return next.selected ? "focus" : "fit";
  const resized =
    previous.width !== next.width || previous.height !== next.height;
  if (
    next.selected &&
    (resized ||
      previous.selected !== next.selected ||
      previous.version !== next.version)
  )
    return "focus";
  if (!next.selected && resized) return "fit";
  return "keep";
}
export type AccountFilters = {
  search: string;
  group: string;
  currency: string;
  favorites: boolean;
  onlyLow: boolean;
  archive: string;
};
export type RevealAccount = Parameters<typeof matchesSearch>[0] &
  Parameters<typeof unitKey>[0] & { favorite: boolean };
/** Preserve useful matching filters; clear only the ones hiding the saved target. */
export function revealAccountFilters(
  a: RevealAccount,
  filters: AccountFilters,
): AccountFilters {
  return {
    search: matchesSearch(a, filters.search) ? filters.search : "",
    group:
      filters.group === "all" || filters.group === a.group
        ? filters.group
        : "all",
    currency:
      filters.currency === "all" || filters.currency === unitKey(a)
        ? filters.currency
        : "all",
    favorites: filters.favorites && a.favorite,
    onlyLow: filters.onlyLow && isLow(a),
    archive:
      filters.archive === "all" ||
      a.archived === (filters.archive === "archived")
        ? filters.archive
        : a.archived
          ? "archived"
          : "active",
  };
}
