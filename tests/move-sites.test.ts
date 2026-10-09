import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import Database from "better-sqlite3";
import type { Account } from "../src/lib/validation";
import * as queries from "../src/lib/query-balance";
import { QueryTrace } from "../src/lib/query-trace";

let directory: string, store: Store;
const token = "a".repeat(64),
  csrf = "b".repeat(48);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "atlas-move-"));
  store = new Store(join(directory, "test.sqlite"), Buffer.alloc(32, 19));
  store.createSession(tokenHash(token), csrf);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  store.close();
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("atlas-move-")
  )
    throw new Error("Unsafe fixture cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const add = (name: string, group = "常用") =>
  store.create({
    name,
    group,
    siteUrl: "https://fixture.example",
    credential: "fixture-secret",
    initialBalance: "9.25",
  });
function move(a: Account, group: string, beforeId: string | null = null) {
  return store.moveAccount({
    id: a.id,
    group,
    beforeId,
    expectedUpdatedAt: a.updatedAt,
  });
}
const ids = (group: string) =>
  store
    .list()
    .filter((a) => a.group === group && !a.archived)
    .sort(
      (a, b) =>
        (a.mapOrder || 0) - (b.mapOrder || 0) || a.id.localeCompare(b.id),
    )
    .map((a) => a.id);
async function post(data: unknown, overrides: Record<string, string> = {}) {
  return handleApi(
    new Request("http://127.0.0.1:3000/api/accounts/move", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: `atlas_session=${token}`,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...overrides,
      },
      body: JSON.stringify(data),
    }),
    ["accounts", "move"],
    store,
  );
}
describe("persistent map moves", () => {
  it("returns the moved account even when only a neighbour rank changes", async () => {
    const a = add("A", "组一"),
      b = add("B", "组二");
    store.batchUpdate({
      ids: [a.id, b.id],
      operation: { kind: "group", group: "常用" },
    });
    const [firstId, secondId] = ids("常用"),
      moving = store.get(secondId)!;
    expect(moving.mapOrder).toBe(0);
    const snapshots = store.history();
    const response = await post({
      id: moving.id,
      group: "常用",
      beforeId: firstId,
      expectedUpdatedAt: moving.updatedAt,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.accounts).toEqual(
      expect.arrayContaining([store.get(moving.id)]),
    );
    expect(ids("常用")).toEqual([secondId, firstId]);
    expect(store.get(moving.id)?.updatedAt).toBe(moving.updatedAt);
    expect(store.history()).toEqual(snapshots);
    expect(store.credential(moving.id)).toBe("fixture-secret");
  });
  it("returns the target for a no-op move without rewriting its metadata", () => {
    const a = add("A"),
      before = store.exportBackup();
    expect(move(a, a.group, a.id)).toEqual([a]);
    expect(store.exportBackup().accounts).toEqual(before.accounts);
    expect(store.history()).toHaveLength(1);
  });
  it("reorders within a group and preserves balance/history/secret", () => {
    const a = add("A"),
      b = add("B"),
      c = add("C"),
      snapshots = store.history(),
      backup = store.exportBackup();
    move(c, "常用", a.id);
    expect(ids("常用")).toEqual([c.id, a.id, b.id]);
    expect(store.get(c.id)?.balance).toBe("9.25");
    expect(store.history()).toEqual(snapshots);
    expect(store.credential(c.id)).toBe("fixture-secret");
    expect(
      store.exportBackup().accounts.find((x) => x.id === c.id)?.details
        .mapOrder,
    ).toBe(0);
    expect(backup.accounts).toHaveLength(3);
  });
  it("cross-group insertion normalizes both groups and appends new sites", () => {
    const a = add("A"),
      b = add("B"),
      c = add("C", "备用"),
      d = add("D", "备用");
    move(a, "备用", d.id);
    expect(ids("常用")).toEqual([b.id]);
    expect(ids("备用")).toEqual([c.id, a.id, d.id]);
    const e = add("E", "备用");
    expect(ids("备用")).toEqual([c.id, a.id, d.id, e.id]);
  });
  it("rejects stale and foreign anchors atomically", () => {
    const a = add("A"),
      b = add("B", "备用"),
      before = store.exportBackup();
    expect(() => move(a, "常用", b.id)).toThrow();
    expect(store.exportBackup().accounts).toEqual(before.accounts);
    move(a, "备用");
    const after = store.exportBackup();
    expect(() => move(a, "常用")).toThrow();
    expect(store.exportBackup().accounts).toEqual(after.accounts);
  });
  it("rejects archived/missing accounts and unexpected write fields", () => {
    const a = add("A");
    store.batchUpdate({
      ids: [a.id],
      operation: { kind: "archive", archived: true },
    });
    expect(() => move(store.get(a.id)!, "备用")).toThrow();
    expect(() =>
      store.moveAccount({
        id: a.id,
        group: "备用",
        beforeId: null,
        expectedUpdatedAt: a.updatedAt,
        credential: "malicious",
      }),
    ).toThrow();
  });
  it("editing metadata without mapOrder retains ordering", () => {
    const a = add("A"),
      b = add("B");
    move(b, "常用", a.id);
    const current = store.get(a.id)!;
    const details = store
      .exportBackup()
      .accounts.find((x) => x.id === a.id)!.details;
    const { mapOrder: _rank, ...withoutRank } = details;
    store.update(a.id, { ...withoutRank, alias: "edited" });
    expect(store.get(a.id)?.mapOrder).toBe(current.mapOrder);
    expect(ids("常用")).toEqual([b.id, a.id]);
  });
  it("rejects a stale editor update after a move instead of reverting its group", () => {
    const a = add("A"),
      stale = store.exportBackup().accounts.find((x) => x.id === a.id)!.details;
    move(a, "备用");
    expect(() =>
      store.update(a.id, {
        ...stale,
        alias: "stale editor",
        expectedUpdatedAt: a.updatedAt,
      }),
    ).toThrow(/已被修改/);
    expect(store.get(a.id)?.group).toBe("备用");
    expect(store.get(a.id)?.alias).toBe("");
  });
  it("late narrow favorite/archive writes never restore cached group or order", async () => {
    const a = add("A");
    move(a, "备用");
    const rank = store.get(a.id)?.mapOrder;
    const res = await handleApi(
      new Request(`http://127.0.0.1:3000/api/accounts/${a.id}/favorite`, {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: `atlas_session=${token}`,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ favorite: true }),
      }),
      ["accounts", a.id, "favorite"],
      store,
    );
    expect(res.status).toBe(200);
    expect(store.get(a.id)?.favorite).toBe(true);
    expect(store.get(a.id)?.group).toBe("备用");
    expect(store.get(a.id)?.mapOrder).toBe(rank);
    store.batchUpdate({
      ids: [a.id],
      operation: { kind: "archive", archived: true },
    });
    expect(store.get(a.id)?.group).toBe("备用");
    expect(store.get(a.id)?.mapOrder).toBe(rank);
  });
  it("query recording and imports cannot reuse an old metadata version during clock rollback", () => {
    const a = add("A"),
      backup = store.exportBackup();
    move(a, "备用");
    let previous = store.get(a.id)!.updatedAt;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    store.record(a.id, "5", "manual", "USD", "");
    expect(store.get(a.id)!.updatedAt > previous).toBe(true);
    previous = store.get(a.id)!.updatedAt;
    store.importBackup(backup, false);
    expect(store.get(a.id)!.updatedAt > previous).toBe(true);
    expect(() =>
      store.update(a.id, {
        ...backup.accounts[0].details,
        expectedUpdatedAt: a.updatedAt,
      }),
    ).toThrow(/已被修改/);
  });
  it("reload and backup restore keep positions", () => {
    const a = add("A"),
      b = add("B");
    move(b, "常用", a.id);
    const backup = store.exportBackup();
    store.close();
    store = new Store(join(directory, "test.sqlite"), Buffer.alloc(32, 19));
    expect(ids("常用")).toEqual([b.id, a.id]);
    const restore = new Store(
      join(directory, "restore.sqlite"),
      Buffer.alloc(32, 20),
    );
    try {
      restore.importBackup(backup, false);
      expect(restore.get(a.id)?.mapOrder).toBe(1);
    } finally {
      restore.close();
    }
  });
  it("rolls back every row when a later update fails; errors are sanitized", () => {
    const a = add("A"),
      b = add("B"),
      c = add("C");
    const before = store.exportBackup(),
      inspection = new Database(join(directory, "test.sqlite"));
    try {
      inspection.exec(
        `CREATE TRIGGER move_fail BEFORE UPDATE ON accounts WHEN OLD.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'fixture-secret'); END`,
      );
      expect(() => move(c, "常用", a.id)).toThrow("移动保存失败；未修改站点");
      expect(store.exportBackup().accounts).toEqual(before.accounts);
      expect(store.history()).toEqual(before.snapshots);
      expect(store.credential(c.id)).toBe("fixture-secret");
    } finally {
      inspection.close();
    }
  });
  it("requires authentication, origin and CSRF; safe response", async () => {
    const a = add("A"),
      data = {
        id: a.id,
        group: "备用",
        beforeId: null,
        expectedUpdatedAt: a.updatedAt,
      };
    expect((await post(data, { cookie: "" })).status).toBe(401);
    expect((await post(data, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await post(data, { origin: "https://evil.example" })).status).toBe(
      403,
    );
    const res = await post(data);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("fixture-secret");
  });
  it("refuses any affected group while its anchor is syncing", async () => {
    const a = add("A"),
      b = add("B");
    const d = store.exportBackup().accounts.find((x) => x.id === b.id)!.details;
    store.update(b.id, { ...d, provider: "newapi", userId: "123" });
    let finish!: (
      value: Awaited<ReturnType<typeof queries.queryBalance>>,
    ) => void;
    vi.spyOn(queries, "queryBalance").mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const running = handleApi(
      new Request(`http://127.0.0.1:3000/api/accounts/${b.id}/sync`, {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: `atlas_session=${token}`,
          "x-csrf-token": csrf,
        },
      }),
      ["accounts", b.id, "sync"],
      store,
    );
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(
        (
          await post({
            id: a.id,
            group: "常用",
            beforeId: b.id,
            expectedUpdatedAt: a.updatedAt,
          })
        ).status,
      ).toBe(409);
    } finally {
      finish({
        result: { balance: "10", unit: "USD", rawQuota: null },
        diagnostic: new QueryTrace({
          provider: "newapi",
          operation: "sync",
          timeoutSeconds: 10,
          dnsMode: "system",
        }).finish(),
      });
      await running;
    }
  });
});
