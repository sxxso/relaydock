export type MapNode = { id: string; x: number; y: number; group: string };
export type MapLayoutAccount = {
  id: string;
  group: string;
  mapOrder?: number;
  archived?: boolean;
};
export type Island = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  seed: number;
};
export function hashText(value: string) {
  let hash = 2166136261;
  for (const ch of value) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
/** A group keeps its colour when filters, order, or visibility change. */
export function groupColorIndex(name: string) {
  return hashText(name || "未分组") % 4;
}
export function compareMapOrder(a: MapLayoutAccount, b: MapLayoutAccount) {
  return (a.mapOrder ?? 0) - (b.mapOrder ?? 0) || a.id.localeCompare(b.id);
}
export function islandHeader(island: Island) {
  const width = island.width * 0.68;
  return {
    x: island.x + (island.width - width) / 2,
    y: island.y + 32,
    width,
    height: 36,
    controlsY: island.y + 70,
  };
}
export function islandTitle(name: string, width: number) {
  const characters = Array.from(name);
  const advance = (ch: string) => (/[\x00-\xff]/.test(ch) ? 23 * 0.65 : 23);
  if (characters.reduce((sum, ch) => sum + advance(ch), 0) <= width)
    return name;
  let available = Math.max(0, width - 23),
    result = "";
  for (const ch of characters) {
    available -= advance(ch);
    if (available < 0) break;
    result += ch;
  }
  return result + "…";
}
export function layoutIslands(
  accounts: MapLayoutAccount[],
  positions: ReadonlyArray<{ name: string; x: number; y: number }> = [],
) {
  const placed = new Map(positions.map((p) => [p.name, p]));
  let groups = new Map<string, MapLayoutAccount[]>();
  for (const a of accounts) {
    let name = a.group || "未分组";
    let list = groups.get(name);
    if (!list) groups.set(name, (list = []));
    list.push(a);
  }
  let nodes: MapNode[] = [],
    islands: Island[] = [],
    rowHeight = 0,
    y = 90;
  let names = [...groups.keys()].sort((a, b) => a.localeCompare(b, "zh"));
  // Many independent groups need a two-dimensional atlas, not a 250-row tower.
  const islandColumns =
    names.length > 8 ? Math.ceil(Math.sqrt(names.length)) : 2;
  // A large island widens only its column, never all other columns.
  const columnWidths = Array<number>(islandColumns).fill(420);
  names.forEach((name, index) => {
    const cols = Math.min(8, Math.ceil(Math.sqrt(groups.get(name)!.length)));
    const column = index % islandColumns;
    columnWidths[column] = Math.max(columnWidths[column], cols * 116 + 111);
  });
  let offset = 55;
  const columnPositions = columnWidths.map((width) => {
    const x = offset;
    offset += width;
    return x;
  });
  for (let index = 0; index < names.length; index++) {
    let name = names[index],
      list = groups.get(name)!.sort(compareMapOrder);
    let cols = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(list.length)))),
      rows = Math.ceil(list.length / cols),
      width = Math.max(260, cols * 116 + 66),
      height = Math.max(270, rows * 116 + 154),
      col = index % islandColumns;
    if (col === 0) {
      if (index > 0) y += rowHeight + 45;
      rowHeight = height;
    } else rowHeight = Math.max(rowHeight, height);
    const position = placed.get(name);
    let x = position?.x ?? columnPositions[col],
      islandY = position?.y ?? y;
    islands.push({ name, x, y: islandY, width, height, seed: hashText(name) });
    list.forEach((a, i) =>
      nodes.push({
        id: a.id,
        group: name,
        x: x + width / 2 + ((i % cols) - (cols - 1) / 2) * 116,
        y: islandY + 136 + Math.floor(i / cols) * 116,
      }),
    );
  }
  const left = Math.min(0, ...islands.map((i) => i.x - 55));
  const top = Math.min(0, ...islands.map((i) => i.y - 60));
  const right = Math.max(900, ...islands.map((i) => i.x + i.width + 55));
  const bottom = Math.max(y + rowHeight + 60, ...islands.map((i) => i.y + i.height + 60));
  return {
    nodes,
    islands,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}
export function islandPath(i: Island) {
  let points: { x: number; y: number }[] = [];
  for (let step = 0; step < 24; step++) {
    let angle = (step / 24) * Math.PI * 2,
      jitter = 1 + Math.sin(step * 2.37 + (i.seed % 100)) * 0.045;
    points.push({
      x: i.x + i.width / 2 + ((Math.cos(angle) * i.width) / 2) * jitter,
      y: i.y + i.height / 2 + ((Math.sin(angle) * i.height) / 2) * jitter,
    });
  }
  let last = points[23],
    first = points[0],
    path =
      "M" +
      ((last.x + first.x) / 2).toFixed(1) +
      "," +
      ((last.y + first.y) / 2).toFixed(1);
  points.forEach((p, n) => {
    let next = points[(n + 1) % 24];
    path +=
      " Q" +
      p.x.toFixed(1) +
      "," +
      p.y.toFixed(1) +
      " " +
      ((p.x + next.x) / 2).toFixed(1) +
      "," +
      ((p.y + next.y) / 2).toFixed(1);
  });
  return path + " Z";
}
