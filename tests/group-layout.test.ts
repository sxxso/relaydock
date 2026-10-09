import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { layoutIslands } from "../src/lib/map-layout";
import * as management from "../src/lib/map-management";
import { groupDragPosition, groupPositionSchema } from "../src/lib/group-layout";

let dir: string, store: Store;
const raw = "e".repeat(64),
  csrf = "f".repeat(48),
  key = Buffer.alloc(32, 24);
function call(
  path: string,
  method = "GET",
  data?: unknown,
  auth = true,
  token = csrf,
) {
  return handleApi(
    new Request("http://localhost/api/" + path, {
      method,
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        ...(auth ? { cookie: "atlas_session=" + raw } : {}),
        "x-csrf-token": token,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    path.split("/"),
    store,
  );
}
const command = (
  name = "常用",
  position: unknown = { x: 640, y: 410 },
  expectedRevision = 0,
) => ({ name, position, expectedRevision });
it("lists saved groups including archived groups, preserving an unsaved current choice", () => {
  expect(management).toHaveProperty("savedGroupNames");
  if (!("savedGroupNames" in management)) return;
  const names = management.savedGroupNames as Function;
  const input = [
    { group: "常用" },
    { group: "备用", archived: true },
    { group: "常用" },
    { group: "" },
  ];
  expect(names(input, "新的")).toEqual(["备用", "常用", "未分组", "新的"]);
  expect(names([...input].reverse(), "新的")).toEqual(names(input, "新的"));
  expect(names([], "")).toEqual(["未分组"]);
});
it("bounds group drag positions and quantizes consistently", () => {
  expect(groupDragPosition({ x: 12.26, y: 34.84 }, { x: 0, y: 0 })).toEqual({
    x: 12.3,
    y: 34.8,
  });
  expect(groupDragPosition({ x: -100, y: 80000 }, { x: 0, y: 0 })).toEqual({
    x: -100,
    y: 80000,
  });
  expect(groupDragPosition({ x: -2000000, y: 2000000 }, { x: -20, y: 20 })).toEqual({ x: -1000000, y: 1000000 });
  for (const x of [NaN, Infinity, -Infinity, -1000001, 1000001])
    expect(groupPositionSchema.safeParse({ name: "常用", x, y: 0 }).success).toBe(false);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-group-layout-"));
  store = new Store(join(dir, "test.sqlite"), key);
  store.createSession(tokenHash(raw), csrf);
  for (const [name, group] of [
    ["A", "常用"],
    ["B", "常用"],
    ["C", "备用"],
  ])
    store.create({
      name,
      group,
      siteUrl: "https://fixture.invalid",
      initialBalance: "12.34",
    });
});
afterEach(() => {
  store.close();
  expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
  expect(basename(dir)).toMatch(/^atlas-group-layout-/);
  rmSync(dir, { recursive: true, force: true });
});
it("translates exactly one island and all its nodes without changing internal order", () => {
  const input = store.list(),
    before = layoutIslands(input);
  const moved = (layoutIslands as Function)(input, [
    { name: "常用", x: 640, y: 410 },
  ]);
  const old = before.islands.find((i) => i.name === "常用")!;
  expect(moved.islands.find((i: any) => i.name === "常用")).toMatchObject({
    x: 640,
    y: 410,
  });
  for (const n of before.nodes) {
    const next = moved.nodes.find((x: any) => x.id === n.id);
    expect(next).toEqual(
      n.group === "常用"
        ? { ...n, x: n.x + 640 - old.x, y: n.y + 410 - old.y }
        : n,
    );
  }
  expect(store.list()).toEqual(input);
});
it("world extent includes moved islands; adding another group does not move an explicit position", () => {
  const input = store.list(),
    positions = [{ name: "常用", x: 2400, y: 1800 }];
  const g = (layoutIslands as Function)(input, positions);
  expect(g.width).toBeGreaterThan(2400);
  expect(g.height).toBeGreaterThan(1800);
  const added = (layoutIslands as Function)(
    [...input, { id: "new", group: "AAA" }],
    positions,
  );
  expect(added.islands.find((i: any) => i.name === "常用")).toMatchObject({
    x: 2400,
    y: 1800,
  });
});
it("publishes empty initial layout and persists a move without touching accounts or history", async () => {
  const before = store.list(),
    history = store.history();
  const initial = await (await call("accounts")).json();
  expect(initial.groupLayout).toEqual({ revision: 0, positions: [] });
  const res = await call("map/groups/move", "POST", command());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    revision: 1,
    positions: [{ name: "常用", x: 640, y: 410 }],
  });
  expect(store.list()).toEqual(before);
  expect(store.history()).toEqual(history);
  store.close();
  store = new Store(join(dir, "test.sqlite"), key);
  expect((await (await call("accounts")).json()).groupLayout.revision).toBe(1);
});
it("persists a negative island across reopening without shifting existing positive positions or accounts", async () => {
  const before = store.list();
  await call("map/groups/move", "POST", command("备用", { x: 640, y: 410 }));
  expect((await call("map/groups/move", "POST", command("常用", { x: -640.5, y: -410.2 }, 1))).status).toBe(200);
  store.close();
  store = new Store(join(dir, "test.sqlite"), key);
  const saved = (await (await call("accounts")).json()).groupLayout;
  expect(saved.revision).toBe(2);
  expect(saved.positions).toEqual(expect.arrayContaining([
    { name: "备用", x: 640, y: 410 }, { name: "常用", x: -640.5, y: -410.2 },
  ]));
  const g = layoutIslands(store.list(), saved.positions);
  expect(g.islands.find(i => i.name === "备用")).toMatchObject({ x: 640, y: 410 });
  expect(g.islands.find(i => i.name === "常用")).toMatchObject({ x: -640.5, y: -410.2 });
  expect(store.list()).toEqual(before);
});
it("requires authentication and CSRF, rejecting unknown groups and malformed coordinates atomically", async () => {
  expect((await call("map/groups/move", "POST", command(), false)).status).toBe(
    401,
  );
  expect(
    (await call("map/groups/move", "POST", command(), true, "wrong")).status,
  ).toBe(403);
  for (const body of [
    command("missing"),
    command("常用", { x: -1000001, y: 1 }),
    command("常用", { x: 1000001, y: 1 }),
    command("常用", { x: "40", y: 1 }),
    { ...command(), credential: "secret" },
  ])
    expect((await call("map/groups/move", "POST", body)).status).toBe(400);
  expect((await (await call("accounts")).json()).groupLayout).toEqual({
    revision: 0,
    positions: [],
  });
});
it("rejects stale revisions; reset removes only that position", async () => {
  expect((await call("map/groups/move", "POST", command())).status).toBe(200);
  expect((await call("map/groups/move", "POST", command("备用"))).status).toBe(
    409,
  );
  expect(
    (
      await call(
        "map/groups/move",
        "POST",
        command("备用", { x: 40, y: 80 }, 1),
      )
    ).status,
  ).toBe(200);
  expect(
    (await call("map/groups/move", "POST", command("常用", null, 2))).status,
  ).toBe(200);
  expect((await (await call("accounts")).json()).groupLayout).toEqual({
    revision: 3,
    positions: [{ name: "备用", x: 40, y: 80 }],
  });
});
it("exports/restores negative positions, previews without mutation and leaves legacy imports compatible", async () => {
  expect((await call("map/groups/move", "POST", command("常用", { x: -640, y: -410 }))).status).toBe(200);
  const backup = store.exportBackup() as any;
  expect(backup.groupPositions).toEqual([{ name: "常用", x: -640, y: -410 }]);
  await call("map/groups/move", "POST", command("常用", null, 1));
  const read = async () => (await (await call("accounts")).json()).groupLayout;
  store.importBackup(backup, true);
  expect((await read()).positions).toEqual([]);
  store.importBackup(backup, false);
  expect((await read()).positions).toEqual(backup.groupPositions);
  const revision = (await read()).revision;
  delete backup.groupPositions;
  store.importBackup(backup, false);
  expect((await read()).revision).toBe(revision);
});
it("rejects duplicate/unknown backup groups and never partially restores positions", async () => {
  await call("map/groups/move", "POST", command());
  const backup = store.exportBackup() as any;
  const before = await (await call("accounts")).json();
  for (const groupPositions of [
    [{ name: "missing", x: 1, y: 1 }],
    [
      { name: "常用", x: 1, y: 1 },
      { name: "常用", x: 2, y: 2 },
    ],
  ]) {
    expect(() =>
      store.importBackup({ ...backup, groupPositions }, false),
    ).toThrow();
    expect(await (await call("accounts")).json()).toEqual(before);
  }
});
