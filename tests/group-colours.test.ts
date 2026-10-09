import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { filterAccounts } from "../src/lib/account-filter";
import { DEFAULT_SAVED_VIEW_FILTERS } from "../src/lib/saved-views";

let dir: string, store: Store;
const raw = "c".repeat(64), csrf = "d".repeat(48), key = Buffer.alloc(32, 27);
async function call(path: string, method = "GET", data?: unknown, auth = true, token = csrf) {
  return handleApi(new Request("http://localhost/api/" + path, {
    method,
    headers: {
      origin: "http://localhost", "content-type": "application/json",
      ...(auth ? { cookie: "atlas_session=" + raw } : {}), "x-csrf-token": token,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), path.split("/"), store);
}
const command = (name = "常用", color: unknown = "#2d648c", expectedRevision = 0) => ({ name, color, expectedRevision });
const read = async () => (await (await call("accounts")).json()).groupColors;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-group-colours-"));
  store = new Store(join(dir, "test.sqlite"), key);
  store.createSession(tokenHash(raw), csrf);
  for (const [name, group, archived] of [["A", "常用", false], ["B", "常用", false], ["C", "备用", true]] as const)
    store.create({ name, group, archived, siteUrl: "https://fixture.invalid", initialBalance: "12.34" });
});
afterEach(() => {
  store.close();
  expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
  expect(basename(dir)).toMatch(/^atlas-group-colours-/);
  rmSync(dir, { recursive: true, force: true });
});
it("saves a normalised group colour without mutating account, balance or layout data", async () => {
  const accounts = store.list(), history = store.history(), layout = store.groupLayout();
  expect((await call("map/groups/color", "POST", command())).status).toBe(200);
  expect(await read()).toEqual({ revision: 1, colors: [{ name: "常用", color: "#2D648C" }] });
  expect(store.list()).toEqual(accounts);
  expect(store.history()).toEqual(history);
  expect(store.groupLayout()).toEqual(layout);
  store.close();
  store = new Store(join(dir, "test.sqlite"), key);
  expect((await read()).colors).toEqual([{ name: "常用", color: "#2D648C" }]);
});
it("starts empty, includes archived groups, and resets only the chosen group", async () => {
  expect(await read()).toEqual({ revision: 0, colors: [] });
  expect((await call("map/groups/color", "POST", command())).status).toBe(200);
  expect((await call("map/groups/color", "POST", command("备用", "#FFFFFF", 1))).status).toBe(200);
  expect((await call("map/groups/color", "POST", command("常用", null, 2))).status).toBe(200);
  expect(await read()).toEqual({ revision: 3, colors: [{ name: "备用", color: "#FFFFFF" }] });
});
it("requires authentication and CSRF and rejects malformed colours atomically", async () => {
  expect((await call("map/groups/color", "POST", command(), false)).status).toBe(401);
  expect((await call("map/groups/color", "POST", command(), true, "wrong")).status).toBe(403);
  for (const value of ["red", "#FFF", "#12345678", "rgb(1,2,3)", "var(--ink)", "#GGGGGG", "", 0, { fill: "#FF0000" }])
    expect((await call("map/groups/color", "POST", command("常用", value))).status).toBe(400);
  for (const data of [command("missing"), { ...command(), secret: "no" }, { ...command(), expectedRevision: -1 }])
    expect((await call("map/groups/color", "POST", data)).status).toBe(400);
  expect(await read()).toEqual({ revision: 0, colors: [] });
});
it("rejects stale tabs without overwriting saved colours", async () => {
  expect((await call("map/groups/color", "POST", command())).status).toBe(200);
  expect((await call("map/groups/color", "POST", command("常用", "#000000"))).status).toBe(409);
  expect((await read()).colors).toEqual([{ name: "常用", color: "#2D648C" }]);
});
it("treats legacy empty group names as ungrouped for colour editing and filtering", async () => {
  const account = store.create({ name: "旧分组", group: "", siteUrl: "https://fixture.invalid" });
  expect(filterAccounts(store.list(), { ...DEFAULT_SAVED_VIEW_FILTERS, group: "未分组" }).map((a) => a.id)).toContain(account.id);
  expect((await call("map/groups/color", "POST", command("未分组"))).status).toBe(200);
  expect((await read()).colors).toEqual([{ name: "未分组", color: "#2D648C" }]);
});
it("moves a custom colour atomically on rename and does not change other groups", async () => {
  await call("map/groups/color", "POST", command());
  await call("map/groups/color", "POST", command("备用", "#8D6958", 1));
  const res = await call("map/groups/rename", "POST", { name: "常用", newName: "工作", expectedRevision: 0 });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.groupColors).toEqual(await read());
  expect((await read()).colors).toEqual([{ name: "工作", color: "#2D648C" }, { name: "备用", color: "#8D6958" }]);
  expect((await call("map/groups/color", "POST", command("工作", "#000000", 2))).status).toBe(409);
});
it("exports and restores colours; preview and old backups never clear current colours", async () => {
  await call("map/groups/color", "POST", command());
  const backup = store.exportBackup() as any;
  expect(backup.groupColors).toEqual([{ name: "常用", color: "#2D648C" }]);
  await call("map/groups/color", "POST", command("常用", "#123456", 1));
  const before = await read();
  store.importBackup(backup, true);
  expect(await read()).toEqual(before);
  store.importBackup(backup, false);
  expect((await read()).colors).toEqual(backup.groupColors);
  delete backup.groupColors;
  const after = await read();
  store.importBackup(backup, false);
  expect(await read()).toEqual(after);
});
it("rejects invalid or duplicate backup colours without partial account changes", async () => {
  await call("map/groups/color", "POST", command());
  const backup = store.exportBackup() as any, before = store.list(), colours = await read();
  for (const groupColors of [
    [{ name: "missing", color: "#123456" }],
    [{ name: "常用", color: "rgb(1,2,3)" }],
    [{ name: "常用", color: "#111111" }, { name: "常用", color: "#222222" }],
  ]) {
    expect(() => store.importBackup({ ...backup, groupColors }, false)).toThrow();
    expect(store.list()).toEqual(before);
    expect(await read()).toEqual(colours);
  }
});
