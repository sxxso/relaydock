import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as layout from "../src/lib/map-layout";
import * as dragHelpers from "../src/lib/map-drag";
import {
  projectMapPoint,
  dragDistanceReached,
  findMapDrop,
  isMapMove,
  previewMapMove,
} from "../src/lib/map-drag";

describe("persistent map order and title row", () => {
  it("sorts by mapOrder (default zero), then ID, without mutating input", () => {
    const input = [
      { id: "z", group: "A", mapOrder: 0 },
      { id: "b", group: "A" },
      { id: "a", group: "A", mapOrder: 2 },
      { id: "c", group: "A", mapOrder: 1 },
    ];
    const before = structuredClone(input);
    expect(layout.layoutIslands(input).nodes.map((n) => n.id)).toEqual([
      "b",
      "z",
      "c",
      "a",
    ]);
    expect(input).toEqual(before);
    expect(layout.layoutIslands([...input].reverse())).toEqual(
      layout.layoutIslands(input),
    );
  });

  it("does not reorder after balance, label, search, or collapse changes", () => {
    const input = Array.from({ length: 40 }, (_, i) => ({
      id: `id-${i}`,
      group: i % 2 ? "A" : "B",
      mapOrder: 40 - i,
    }));
    expect(
      layout.layoutIslands(
        input
          .map((a, i) => ({
            ...a,
            balance: `${i}`,
            name: "updated",
            matching: false,
            collapsed: true,
          }))
          .reverse(),
      ),
    ).toEqual(layout.layoutIslands(input));
  });

  it("reserves a centered top title row inside every island, clear of node halos", () => {
    expect(layout).toHaveProperty("islandHeader");
    if (!("islandHeader" in layout)) return;
    for (const count of [1, 4, 64, 500]) {
      const g = layout.layoutIslands(
        Array.from({ length: count }, (_, i) => ({
          id: `${i}`,
          group: "非常长的完整分组名称".repeat(4),
        })),
      );
      const island = g.islands[0];
      const header = (
        layout.islandHeader as (i: layout.Island) => {
          x: number;
          y: number;
          width: number;
          height: number;
          controlsY: number;
        }
      )(island);
      expect(header.x + header.width / 2).toBe(island.x + island.width / 2);
      expect(header.x).toBeGreaterThan(island.x);
      expect(header.x + header.width).toBeLessThan(island.x + island.width);
      expect(header.y).toBeGreaterThan(island.y);
      expect(header.y + header.height).toBeLessThanOrEqual(header.controlsY);
      expect(header.controlsY + 28).toBeLessThan(
        Math.min(...g.nodes.map((n) => n.y)) - 32,
      );
    }
  });

  it("fits mixed-script long SVG titles with an ellipsis, retaining short names", () => {
    expect(layout).toHaveProperty("islandTitle");
    if (!("islandTitle" in layout)) return;
    const title = layout.islandTitle as (name: string, width: number) => string;
    expect(title("短名称", 200)).toBe("短名称");
    expect(title("Short name", 200)).toBe("Short name");
    for (const name of [
      "完整的分组名称用于测试不会遮住首行站点".repeat(3),
      "A very long ASCII group name".repeat(3),
      "🐦分组".repeat(20),
    ]) {
      const result = title(name, 176);
      expect(result.endsWith("…")).toBe(true);
      expect(Array.from(result).length).toBeLessThan(Array.from(name).length);
      expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });
});

const input = [
  { id: "a", group: "A", mapOrder: 2 },
  { id: "b", group: "A", mapOrder: 0 },
  { id: "c", group: "A", mapOrder: 1 },
  { id: "d", group: "A", mapOrder: 3 },
  { id: "x", group: "B", mapOrder: 0 },
  { id: "y", group: "B", mapOrder: 1 },
];
const geometry = layout.layoutIslands(input);
const node = (id: string) => geometry.nodes.find((n) => n.id === id)!;

describe("pure pointer projection and drop resolution", () => {
  it("resolves insertion and selection projection on islands left and above the origin", () => {
    const g = layout.layoutIslands(input, [{ name: "B", x: -1200, y: -900 }]);
    const destination = g.nodes.find(n => n.id === "y")!;
    const camera = { x: 1500, y: 1200, k: 1 };
    const point = projectMapPoint({ x: destination.x + camera.x - 10, y: destination.y + camera.y },
      { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, camera)!;
    expect(findMapDrop(point, "a", g.islands, g.nodes)).toMatchObject({ group: "B", beforeId: "y" });
  });
  it("rejects captured pointers outside the SVG viewport even inside a world island", () => {
    const g = layout.layoutIslands(
      Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, group: "A" })),
    );
    const camera = { x: 0, y: -176, k: 1 };
    const screen = { a: 1, b: 0, c: 0, d: 1, e: 20, f: 20 };
    const pointer = { x: 418, y: 355 };
    const unbounded = projectMapPoint(pointer, screen, camera)!;
    expect(findMapDrop(unbounded, "0", g.islands, g.nodes)).toMatchObject({
      group: "A",
      beforeId: null,
    });
    const project = projectMapPoint;
    expect(
      project(pointer, screen, camera, { width: 900, height: 300 }),
    ).toBeNull();
    for (const p of [
      { x: 19, y: 21 },
      { x: 21, y: 19 },
      { x: 921, y: 21 },
      { x: 21, y: 321 },
    ])
      expect(
        project(p, screen, camera, { width: 900, height: 300 }),
      ).toBeNull();
    expect(
      project({ x: 30, y: 40 }, screen, camera, { width: 900, height: 300 }),
    ).toEqual({ x: 10, y: 196 });
  });

  it("clips the viewport after affine screen projection, before camera projection", () => {
    const project = projectMapPoint;
    const matrix = { a: 0, b: 2, c: -2, d: 0, e: 10, f: 5 };
    expect(
      project(
        { x: -14, y: 27 },
        matrix,
        { x: 0, y: 0, k: 1 },
        { width: 20, height: 20 },
      ),
    ).toEqual({ x: 11, y: 12 });
    expect(
      project(
        { x: -34, y: 27 },
        matrix,
        { x: 0, y: 0, k: 1 },
        { width: 20, height: 20 },
      ),
    ).toBeNull();
  });
  it("projects CSS-scaled SVG coordinates through the current pan/zoom", () => {
    const matrix = { a: 2, b: 0, c: 0, d: 1.5, e: 40, f: 80 };
    const camera = { x: -120, y: 35, k: 0.6 };
    for (const id of ["b", "x"]) {
      const n = node(id);
      const point = projectMapPoint(
        {
          x: 40 + 2 * (camera.x + n.x * camera.k),
          y: 80 + 1.5 * (camera.y + n.y * camera.k),
        },
        matrix,
        camera,
      )!;
      expect(point.x).toBeCloseTo(n.x);
      expect(point.y).toBeCloseTo(n.y);
      expect(
        findMapDrop(
          { x: point.x - 1, y: point.y },
          "d",
          geometry.islands,
          geometry.nodes,
        )?.beforeId,
      ).toBe(id);
    }
  });
  it("supports affine SVG transforms, and rejects degenerate transforms", () => {
    expect(
      projectMapPoint(
        { x: -14, y: 27 },
        {
          a: 0,
          b: 2,
          c: -2,
          d: 0,
          e: 10,
          f: 5,
        },
        { x: 0, y: 0, k: 1 },
      ),
    ).toEqual({ x: 11, y: 12 });
    expect(
      projectMapPoint(
        { x: 0, y: 0 },
        {
          a: 0,
          b: 0,
          c: 0,
          d: 0,
          e: 0,
          f: 0,
        },
        { x: 0, y: 0, k: 1 },
      ),
    ).toBeNull();
  });
  it("distinguishes clicks below six screen pixels from a mouse or touch drag", () => {
    expect(dragDistanceReached({ x: 1, y: 1 }, { x: 6.9, y: 1 })).toBe(false);
    expect(dragDistanceReached({ x: 1, y: 1 }, { x: 7, y: 1 })).toBe(true);
    expect(dragDistanceReached({ x: 0, y: 0 }, { x: 3.6, y: 4.8 })).toBe(true);
  });
  it("reorders within a group using stable spatial rows, not ID or input order", () => {
    const b = node("b"),
      c = node("c"),
      a = node("a");
    expect(
      findMapDrop(
        { x: b.x - 10, y: b.y },
        "d",
        geometry.islands,
        [...geometry.nodes].reverse(),
      ),
    ).toMatchObject({ group: "A", beforeId: "b" });
    expect(
      findMapDrop(
        { x: c.x - 10, y: c.y },
        "d",
        geometry.islands,
        geometry.nodes,
      ),
    ).toMatchObject({ group: "A", beforeId: "c" });
    expect(
      findMapDrop(
        { x: c.x + 10, y: c.y },
        "d",
        geometry.islands,
        geometry.nodes,
      ),
    ).toMatchObject({ group: "A", beforeId: "a" });
    expect(
      findMapDrop(
        { x: a.x + 10, y: a.y },
        "d",
        geometry.islands,
        geometry.nodes,
      ),
    ).toMatchObject({ group: "A", beforeId: null });
  });
  it("moves across islands; excludes the source from insertion targets", () => {
    const x = node("x"),
      b = node("b");
    expect(
      findMapDrop(
        { x: x.x - 1, y: x.y },
        "d",
        geometry.islands,
        geometry.nodes,
      ),
    ).toMatchObject({ group: "B", beforeId: "x" });
    expect(findMapDrop(b, "b", geometry.islands, geometry.nodes)).toMatchObject(
      { group: "A", beforeId: "c" },
    );
    expect(isMapMove("b", { group: "A", beforeId: "c" }, geometry.nodes)).toBe(
      false,
    );
    expect(isMapMove("d", { group: "B", beforeId: "x" }, geometry.nodes)).toBe(
      true,
    );
    expect(isMapMove("d", { group: "A", beforeId: "b" }, geometry.nodes)).toBe(
      true,
    );
  });
  it("cancels outside all visible islands, even when hidden nodes exist", () => {
    expect(
      findMapDrop({ x: -100, y: 100 }, "d", geometry.islands, geometry.nodes),
    ).toBeNull();
    expect(
      findMapDrop(
        node("x"),
        "d",
        geometry.islands.filter((i) => i.name !== "B"),
        geometry.nodes,
      ),
    ).toBeNull();
    expect(
      findMapDrop({ x: NaN, y: 0 }, "d", geometry.islands, geometry.nodes),
    ).toBeNull();
  });
  it("appends on a collapsed island or below the last spatial row", () => {
    const island = geometry.islands.find((i) => i.name === "B")!;
    expect(
      findMapDrop(
        node("x"),
        "d",
        geometry.islands,
        geometry.nodes,
        new Set(["B"]),
      ),
    ).toMatchObject({ group: "B", beforeId: null });
    expect(
      findMapDrop(
        { x: island.x + island.width / 2, y: island.y + island.height - 12 },
        "d",
        geometry.islands,
        geometry.nodes,
      ),
    ).toMatchObject({ group: "B", beforeId: null });
  });
});

describe("optimistic move preview (parent owns persistence)", () => {
  it("compares full active order for no-ops while keeping anchors visible and active", () => {
    const accounts = [
      { id: "a", group: "A", mapOrder: 0 },
      { id: "hidden", group: "A", mapOrder: 1 },
      { id: "c", group: "A", mapOrder: 2 },
      { id: "archived", group: "A", mapOrder: 3, archived: true },
    ];
    const g = layout.layoutIslands(accounts);
    const visible = dragHelpers.movableMapNodes(
      g.nodes,
      accounts,
      new Set(["a", "c"]),
    );
    const active = dragHelpers.movableMapNodes(
      g.nodes,
      accounts,
      new Set(accounts.map((a) => a.id)),
    );
    const c = g.nodes.find((n) => n.id === "c")!;
    const target = findMapDrop(
      { x: c.x - 10, y: c.y },
      "a",
      g.islands,
      visible,
    )!;
    expect(target.beforeId).toBe("c");
    const isMove = isMapMove;
    expect(isMove("a", target, visible, active)).toBe(true);
    expect(
      isMove("a", { group: "A", beforeId: "hidden" }, visible, active),
    ).toBe(false);
    expect(
      isMove("a", { group: "A", beforeId: "archived" }, visible, active),
    ).toBe(false);
    expect(isMove("c", { group: "A", beforeId: null }, visible, active)).toBe(
      false,
    );
    const preview = previewMapMove(accounts, { id: "a", ...target });
    expect(preview.find((a) => a.id === "archived")).toBe(accounts[3]);
    expect(
      [...preview]
        .filter((a) => !a.archived)
        .sort(layout.compareMapOrder)
        .map((a) => a.id),
    ).toEqual(["hidden", "a", "c"]);
  });
  it("keeps archived objects and ranks untouched and refuses archived sources", () => {
    const accounts = [
      { id: "a", group: "A", mapOrder: 1, archived: false },
      { id: "archived", group: "B", mapOrder: 0, archived: true },
      { id: "b", group: "B", mapOrder: 1, archived: false },
      { id: "c", group: "B", mapOrder: 2, archived: false },
    ];
    const preview = previewMapMove(accounts, {
      id: "a",
      group: "B",
      beforeId: "b",
    });
    expect(preview.find((a) => a.id === "archived")).toBe(accounts[1]);
    expect(preview.find((a) => a.id === "a")?.mapOrder).toBe(0);
    expect(preview.find((a) => a.id === "b")?.mapOrder).toBe(1);
    expect(
      previewMapMove(accounts, { id: "archived", group: "A", beforeId: "a" }),
    ).toBe(accounts);
    expect(
      previewMapMove(accounts, { id: "a", group: "B", beforeId: "archived" }),
    ).toBe(accounts);
  });

  it("uses only active scoped drop and keyboard anchors, without changing full geometry", () => {
    expect(dragHelpers).toHaveProperty("movableMapNodes");
    if (!("movableMapNodes" in dragHelpers)) return;
    const accounts = [
      { id: "a", group: "A", mapOrder: 0 },
      { id: "archived", group: "B", mapOrder: 0, archived: true },
      { id: "hidden", group: "B", mapOrder: 1 },
      { id: "visible", group: "B", mapOrder: 2 },
    ];
    const g = layout.layoutIslands(accounts);
    const visibleIds = new Set(["a", "archived", "visible"]);
    const movable = (
      dragHelpers.movableMapNodes as (
        nodes: layout.MapNode[],
        items: typeof accounts,
        ids: ReadonlySet<string>,
      ) => layout.MapNode[]
    )(g.nodes, accounts, visibleIds);
    expect(movable.map((n) => n.id)).toEqual(["a", "visible"]);
    const archivedPosition = g.nodes.find((n) => n.id === "archived")!;
    const target = findMapDrop(archivedPosition, "a", g.islands, movable);
    expect(target).toMatchObject({ group: "B", beforeId: "visible" });
    expect(isMapMove("archived", { group: "A", beforeId: "a" }, movable)).toBe(
      false,
    );
    expect(layout.layoutIslands(accounts)).toEqual(g);
  });
  it("reorders one group without mutating account objects or balance fields", () => {
    const original = input.map((a) =>
      Object.freeze({ ...a, balance: "fixture" }),
    );
    const updated = previewMapMove(original, {
      id: "d",
      group: "A",
      beforeId: "c",
    });
    expect(
      layout
        .layoutIslands(updated)
        .nodes.filter((n) => n.group === "A")
        .map((n) => n.id),
    ).toEqual(["b", "d", "c", "a"]);
    expect(updated.find((a) => a.id === "x")).toBe(
      original.find((a) => a.id === "x"),
    );
    expect(updated.every((a) => a.balance === "fixture")).toBe(true);
    expect(layout.layoutIslands(original)).toEqual(geometry);
  });
  it("previews a cross-group insert and append with default order ties", () => {
    const updated = previewMapMove(input, {
      id: "d",
      group: "B",
      beforeId: "y",
    });
    expect(
      layout
        .layoutIslands(updated)
        .nodes.filter((n) => n.group === "B")
        .map((n) => n.id),
    ).toEqual(["x", "d", "y"]);
    const appended = previewMapMove(input, {
      id: "d",
      group: "B",
      beforeId: null,
    });
    expect(
      layout
        .layoutIslands(appended)
        .nodes.filter((n) => n.group === "B")
        .map((n) => n.id),
    ).toEqual(["x", "y", "d"]);
    const ties = input.map((a) => ({ id: a.id, group: a.group }));
    expect(
      layout
        .layoutIslands(
          previewMapMove(ties, { id: "y", group: "B", beforeId: "x" }),
        )
        .nodes.filter((n) => n.group === "B")
        .map((n) => n.id),
    ).toEqual(["y", "x"]);
  });
  it("rejects stale/missing/self insertion targets and missing sources", () => {
    for (const move of [
      { id: "missing", group: "B", beforeId: null },
      { id: "d", group: "B", beforeId: "d" },
      { id: "d", group: "B", beforeId: "b" },
      { id: "d", group: "B", beforeId: "missing" },
    ])
      expect(previewMapMove(input, move)).toEqual(input);
    expect(isMapMove("d", { group: "B", beforeId: "b" }, geometry.nodes)).toBe(
      false,
    );
  });
});

describe("gesture-owned click suppression", () => {
  it("suppresses the eventual pointer click regardless of how long a cancelled pointer stays held", () => {
    expect(dragHelpers).toHaveProperty("createMapClickGuard");
    if (!("createMapClickGuard" in dragHelpers)) return;
    const guard = (
      dragHelpers.createMapClickGuard as () => {
        beginPointer: () => void;
        endPointer: () => void;
        allowsClick: (detail: number) => boolean;
      }
    )();
    guard.beginPointer();
    guard.endPointer();
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60000);
      expect(guard.allowsClick(1)).toBe(false);
      expect(guard.allowsClick(0)).toBe(true);
      expect(guard.allowsClick(1)).toBe(false);
      guard.beginPointer();
      expect(guard.allowsClick(1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Opt-in, map-only browser regressions: RELAYDOCK_MAP_GESTURES=1. No app server or DB.
describe.skipIf(process.env.RELAYDOCK_MAP_GESTURES !== "1")(
  "map gesture review regressions",
  () => {
    let browser: import("playwright").Browser;
    let page: import("playwright").Page;
    let server: import("node:http").Server;
    let temp = "";
    const errors: string[] = [];
    const fixture = (id: string, mapOrder: number, archived = false) => ({
      id,
      group: "A",
      mapOrder,
      archived,
      name: id,
      alias: "fixture",
      balance: "3",
      balanceUnit: "USD",
      lowBalanceThreshold: "0",
      favorite: false,
      balanceUpdatedAt: null,
      balanceAttemptedAt: null,
      queryDiagnostic: null,
      testDiagnostic: null,
    });
    const fixtures = Array.from({ length: 9 }, (_, i) => fixture(`${i}`, i));
    beforeAll(async () => {
      const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join, resolve } = await import("node:path");
      const { createServer } = await import("node:http");
      const { build } = await import("esbuild");
      const { chromium } = await import("playwright");
      const root = resolve(import.meta.dirname, "..");
      temp = await mkdtemp(join(tmpdir(), "relaydock-map-regression-"));
      await build({
        stdin: {
          resolveDir: root,
          loader: "tsx",
          contents: `
        import React,{useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {AtlasMap} from '@/components/atlas-map';
        import {previewMapMove} from '@/lib/map-drag';
        const fixtures=${JSON.stringify(fixtures)};
        window.h={calls:[],selected:[],accounts:fixtures,reset:null,setMotion:null,setShown:null};
        function App(){
          const [accounts,setAccounts]=useState(fixtures),[scope,setScope]=useState(fixtures.map(a=>a.id));
          const [motion,setMotion]=useState(false),[shown,setShown]=useState(true);
          window.h.accounts=accounts;
          window.h.setMotion=setMotion;window.h.setShown=setShown;
          window.h.reset=(items,ids)=>{window.h.calls=[];window.h.selected=[];setAccounts(items);setScope(ids);};
          return shown && <AtlasMap accounts={accounts} selected={null} onSelect={id=>window.h.selected.push(id)}
            motion={motion} freshnessNow={0} matchingIds={new Set(scope)} scopeIds={new Set(scope)}
            collapsedGroups={new Set()} onToggleGroup={()=>{}}
            onMove={async(id,group,beforeId)=>{window.h.calls.push({id,group,beforeId});setAccounts(old=>previewMapMove(old,{id,group,beforeId}));}} />;
        }
        createRoot(document.getElementById('root')).render(<App/>);
      `,
        },
        bundle: true,
        format: "iife",
        jsx: "automatic",
        outfile: join(temp, "bundle.js"),
        alias: { "@": join(root, "src") },
        define: { "process.env.NODE_ENV": '"development"' },
        logLevel: "silent",
      });
      const css = (
        await readFile(join(root, "src/app/globals.css"), "utf8")
      ).replace('@import "tailwindcss";', "");
      await writeFile(
        join(temp, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>${css}
      body{margin:0;padding:20px}#root{width:900px}.atlas-map{height:300px!important;min-height:300px!important;max-height:300px!important}
      </style><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`,
      );
      server = createServer(async (req, res) => {
        const files: Record<string, string> = {
          "/": "index.html",
          "/bundle.js": "bundle.js",
          "/bundle.css": "bundle.css",
        };
        const file = files[req.url ?? ""];
        if (!file) {
          res.writeHead(404).end();
          return;
        }
        res.setHeader(
          "content-type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        res.end(await readFile(join(temp, file)));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
      await page.addInitScript(() => {
        const host = window as unknown as {
          mapPerf: { commits: number; nodeRefs: number; rafs: number };
          __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown;
        };
        host.mapPerf = { commits: 0, nodeRefs: 0, rafs: 0 };
        host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true,
          renderers: new Map(),
          inject: () => 1,
          onCommitFiberRoot: () => host.mapPerf.commits++,
          onCommitFiberUnmount: () => {},
        };
        // Inline node ref callbacks run again on a map render even if DOM props
        // are unchanged. Count those, not just DOM mutations or root commits.
        const set = Map.prototype.set;
        Map.prototype.set = function (key, value) {
          if (
            value instanceof SVGGElement &&
            value.hasAttribute("data-account-id")
          )
            host.mapPerf.nodeRefs++;
          return set.call(this, key, value);
        };
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => {
          host.mapPerf.rafs++;
          return raf(callback);
        };
      });
      page.setDefaultTimeout(6000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1"
          ? route.continue()
          : route.abort(),
      );
      const port = (server.address() as import("node:net").AddressInfo).port;
      await page.goto(`http://127.0.0.1:${port}`);
      await page.locator('[data-account-id="0"]').waitFor();
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      if (server)
        await new Promise<void>((r, reject) =>
          server.close((e) => (e ? reject(e) : r())),
        );
      if (temp) {
        const { resolve, dirname, basename } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const target = resolve(temp);
        if (
          dirname(target) !== resolve(tmpdir()) ||
          !basename(target).startsWith("relaydock-map-regression-")
        )
          throw new Error(
            "Refusing to remove a path outside the generated map-test directory",
          );
        await (
          await import("node:fs/promises")
        ).rm(target, { recursive: true, force: true });
      }
      expect(errors).toEqual([]);
    });
    async function idle() {
      await page.waitForFunction(
        () => {
          const map = document.querySelector('[data-testid="atlas-map"]');
          const svg = document.querySelector(".atlas-svg") as SVGSVGElement & {
            __transition?: unknown;
          };
          return (
            map?.getAttribute("data-panning") === "false" && !svg.__transition
          );
        },
        undefined,
        { polling: 25 },
      );
    }
    async function reset(items = fixtures, ids = items.map((a) => a.id)) {
      await page.evaluate(
        ({ items, ids }) =>
          (
            window as unknown as {
              h: { reset: (a: typeof items, b: string[]) => void };
            }
          ).h.reset(items, ids),
        { items, ids },
      );
      await idle();
      await page
        .getByRole("button", { name: "显示全部站点", exact: true })
        .click();
      await idle();
    }
    beforeEach(async () => {
      await reset();
    });
    async function center(id: string) {
      const box = await page
        .locator(`[data-account-id="${id}"] .node-core`)
        .boundingBox();
      expect(box).not.toBeNull();
      return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    }
    async function result() {
      return page.evaluate(
        () =>
          (
            window as unknown as {
              h: {
                calls: { id: string; group: string; beforeId: string | null }[];
                selected: string[];
                accounts: typeof fixtures;
              };
            }
          ).h,
      );
    }
    async function perf(reset = false) {
      return page.evaluate((reset) => {
        const host = window as unknown as {
          mapPerf: { commits: number; nodeRefs: number; rafs: number };
        };
        if (reset) host.mapPerf = { commits: 0, nodeRefs: 0, rafs: 0 };
        return host.mapPerf;
      }, reset);
    }
    async function scaleTo(k: number) {
      const box = (await page.locator(".atlas-svg").boundingBox())!;
      const current = await page
        .locator(".atlas-svg")
        .evaluate(
          (el) => (el as SVGSVGElement & { __zoom: { k: number } }).__zoom.k,
        );
      await page.mouse.move(box.x + 10, box.y + 100);
      await page.mouse.wheel(0, Math.log2(current / k) / 0.002);
      await page.waitForFunction(
        (k) =>
          Math.abs(
            (
              document.querySelector(".atlas-svg") as SVGSVGElement & {
                __zoom: { k: number };
              }
            ).__zoom.k - k,
          ) < 0.00001,
        k,
        { polling: 25 },
      );
      await idle();
    }
    async function camera() {
      return page.locator(".atlas-svg").evaluate((el) => {
        const { x, y, k } = (el as SVGSVGElement & { __zoom: { x: number; y: number; k: number } }).__zoom;
        return { x, y, k };
      });
    }
    it.each(["space", "middle"])("%s pan starts over a node without moving or activating it", async (kind) => {
      const source = await center("0"), before = await camera();
      await page.locator(".atlas-svg").focus();
      await page.mouse.move(source.x, source.y);
      if (kind === "space") await page.keyboard.down("Space");
      await page.mouse.down({ button: kind === "middle" ? "middle" : "left" });
      await page.mouse.move(source.x + 65, source.y + 25, { steps: 6 });
      await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
      if (kind === "space") await page.keyboard.up("Space");
      await idle();
      const after = await camera();
      expect(after.x - before.x).toBeCloseTo(65, 1);
      expect(after.y - before.y).toBeCloseTo(25, 1);
      expect(after.k).toBe(before.k);
      expect((await result()).calls).toEqual([]);
      expect((await result()).selected).toEqual([]);
    });
    it("Space release and window blur end captured pan without leaving sticky gesture state", async () => {
      const source = await center("0");
      await page.locator(".atlas-svg").focus();
      await page.mouse.move(source.x, source.y);
      await page.keyboard.down("Space");
      await page.mouse.down();
      await page.mouse.move(source.x + 30, source.y);
      await page.keyboard.up("Space");
      await idle();
      const stopped = await camera();
      await page.mouse.move(source.x + 70, source.y + 5);
      expect(await camera()).toEqual(stopped);
      await page.mouse.up();
      await page.keyboard.down("Space");
      const next = await center("1");
      await page.mouse.move(next.x, next.y);
      await page.mouse.down();
      await page.mouse.move(next.x + 20, next.y);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await idle();
      await page.mouse.up();
      await page.keyboard.up("Space");
      const fresh = await center("1");
      await page.mouse.click(fresh.x, fresh.y);
      expect((await result()).calls).toEqual([]);
      expect((await result()).selected).toEqual(["1"]);
    });
    it("separated wheel gestures render nodes only once at the real LOD threshold, never at activity boundaries", async () => {
      const items = Array.from({ length: 500 }, (_, i) => fixture(`${i}`, i));
      await reset(items);
      await scaleTo(0.4);
      await perf(true);
      // Deliberately exceed d3's 150ms wheel idle on every event. This is
      // deterministic burst fragmentation, not a machine-speed assertion.
      for (let i = 0; i < 20; i++) {
        const previous = await page
          .locator(".atlas-svg")
          .evaluate(
            (el) => (el as SVGSVGElement & { __zoom: { k: number } }).__zoom.k,
          );
        await page.mouse.wheel(0, -28);
        await page.waitForFunction(
          (previous) =>
            (
              document.querySelector(".atlas-svg") as SVGSVGElement & {
                __zoom: { k: number };
              }
            ).__zoom.k !== previous,
          previous,
          { polling: 25 },
        );
        await idle();
      }
      expect(await perf()).toMatchObject({ commits: 1, nodeRefs: 500 });
      expect(await page.locator("[data-account-id]").count()).toBe(500);
      await perf(true);
      await page.waitForTimeout(650);
      expect(await perf()).toEqual({ commits: 0, nodeRefs: 0, rafs: 0 });
    }, 20000);
    it("held blank-space pan and node drag pause ink without node rerenders, then resume and clean up", async () => {
      await page.evaluate(() =>
        (
          window as unknown as { h: { setMotion: (v: boolean) => void } }
        ).h.setMotion(true),
      );
      await idle();
      await scaleTo(0.7);
      const map = page.getByTestId("atlas-map"),
        canvas = page.locator(".ink-canvas"),
        box = (await page.locator(".atlas-svg").boundingBox())!;
      const blank = { x: box.x + 10, y: box.y + 100 };
      await page.waitForTimeout(30);
      await page.mouse.move(blank.x + 5, blank.y);
      await page.waitForFunction(
        () =>
          document
            .querySelector(".ink-canvas")
            ?.getAttribute("data-animating") === "true",
        undefined,
        { polling: 10 },
      );
      await perf(true);
      await page.mouse.down();
      await page.mouse.move(blank.x + 20, blank.y + 10);
      await page.mouse.wheel(0, -1);
      await page.waitForTimeout(300);
      expect(await map.getAttribute("data-panning")).toBe("true");
      expect(await canvas.getAttribute("data-animating")).toBe("false");
      expect(await perf()).toMatchObject({ commits: 0, nodeRefs: 0 });
      await page.mouse.up();
      await idle();
      expect(await perf()).toMatchObject({ commits: 0, nodeRefs: 0 });
      const source = await center("0");
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      await page.mouse.move(source.x + 12, source.y);
      expect(await map.getAttribute("data-panning")).toBe("true");
      expect(await map.getAttribute("data-dragging")).toBe("true");
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await idle();
      expect(await perf()).toMatchObject({ commits: 0, nodeRefs: 0 });
      expect((await result()).calls).toEqual([]);
      await page.waitForTimeout(30);
      await page.mouse.move(blank.x, blank.y + 25);
      await page.waitForFunction(
        () =>
          document
            .querySelector(".ink-canvas")
            ?.getAttribute("data-animating") === "true",
        undefined,
        { polling: 10 },
      );
      // Unmount with a held d3 mouse gesture; window listeners, ink and RAF
      // must all stop, and a new map must start idle.
      await page.mouse.down();
      await page.evaluate(() =>
        (
          window as unknown as { h: { setShown: (v: boolean) => void } }
        ).h.setShown(false),
      );
      await page.waitForFunction(
        () => !document.querySelector(".atlas-svg"),
        undefined,
        { polling: 25 },
      );
      await page.mouse.up();
      await perf(true);
      await page.waitForTimeout(650);
      expect(await perf()).toEqual({ commits: 0, nodeRefs: 0, rafs: 0 });
      expect(
        await page.evaluate(() => document.documentElement.style.userSelect),
      ).toBe("");
      await page.evaluate(() => {
        const h = (
          window as unknown as {
            h: {
              setShown: (v: boolean) => void;
              setMotion: (v: boolean) => void;
            };
          }
        ).h;
        h.setMotion(false);
        h.setShown(true);
      });
      await idle();
      expect(await map.getAttribute("data-panning")).toBe("false");
    }, 15000);
    it("Escape held beyond 800ms never activates the source on release; fresh pointer/keyboard activation works", async () => {
      const source = await center("0");
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      await page.mouse.move(source.x + 18, source.y);
      await page.keyboard.press("Escape");
      await page.mouse.move(source.x, source.y);
      await page.waitForTimeout(1100);
      await page.mouse.up();
      expect((await result()).selected).toEqual([]);
      expect((await result()).calls).toEqual([]);
      const next = await center("1");
      await page.mouse.click(next.x, next.y);
      await page.locator('[data-account-id="2"]').focus();
      await page.keyboard.press("Enter");
      expect((await result()).selected).toEqual(["1", "2"]);
    });
    it("rejects release outside the SVG even when zoomed world-island bounds contain the pointer", async () => {
      const box = await page.locator(".atlas-svg").boundingBox();
      const k = await page
        .locator(".atlas-svg")
        .evaluate(
          (el) => (el as SVGSVGElement & { __zoom: { k: number } }).__zoom.k,
        );
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, Math.log2(k) / 0.002);
      await page.waitForFunction(
        () =>
          Math.abs(
            (
              document.querySelector(".atlas-svg") as SVGSVGElement & {
                __zoom: { k: number };
              }
            ).__zoom.k - 1,
          ) < 0.001,
      );
      await idle();
      const pointer = await page.locator(".atlas-svg").evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const svg = el as SVGSVGElement & {
          __zoom: { x: number; y: number; k: number };
        };
        const island = document.querySelector(
          '[data-island-group="A"] .island-wash',
        ) as SVGGraphicsElement;
        const b = island.getBBox(),
          t = svg.__zoom;
        const local = { x: 398 * t.k + t.x, y: bounds.height + 35 };
        const world = { x: (local.x - t.x) / t.k, y: (local.y - t.y) / t.k };
        return {
          x: bounds.left + local.x,
          y: bounds.top + local.y,
          inside:
            world.x > b.x &&
            world.x < b.x + b.width &&
            world.y > b.y &&
            world.y < b.y + b.height,
        };
      });
      expect(pointer.inside).toBe(true);
      const source = await center("3");
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      await page.mouse.move(pointer.x, pointer.y, { steps: 12 });
      expect(
        await page.getByTestId("atlas-map").getAttribute("data-dragging"),
      ).toBe("true");
      await page.mouse.up();
      expect((await result()).calls).toEqual([]);
      expect((await result()).selected).toEqual([]);
    });
    it("scoped a-before-c submits against full active order and preserves hidden/archived accounts", async () => {
      const items = [
        fixture("a", 0),
        fixture("hidden", 1),
        fixture("c", 2),
        fixture("archived", 3, true),
      ];
      await reset(items, ["a", "c"]);
      const source = await center("a"),
        target = await center("c");
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      await page.mouse.move(target.x - 10, target.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="atlas-map"]')
            ?.getAttribute("data-move-pending") === "false",
      );
      const state = await result();
      expect(state.calls).toEqual([{ id: "a", group: "A", beforeId: "c" }]);
      expect(state.accounts.find((a) => a.id === "archived")).toEqual(items[3]);
      expect(
        state.accounts
          .filter((a) => !a.archived)
          .sort(layout.compareMapOrder)
          .map((a) => a.id),
      ).toEqual(["hidden", "a", "c"]);
      expect(state.selected).toEqual([]);
    });
  },
);
