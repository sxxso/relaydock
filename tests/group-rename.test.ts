import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import * as crypto from "../src/lib/crypto";
import * as queries from "../src/lib/query-balance";
import { layoutIslands } from "../src/lib/map-layout";
import { groupPositionSchema, type GroupLayout } from "../src/lib/group-layout";
import type { Account } from "../src/lib/validation";

const prefix = "relaydock-group-rename-";
const key = Buffer.alloc(32, 29);
const token = "a".repeat(64),
  csrf = "b".repeat(48);
let directory: string,
  path: string,
  store: Store,
  inspection: Database.Database;
type RawAccount = { id: string; payload: string; secret: string | null };
type RenameResult = { accounts: Account[]; groupLayout: GroupLayout };

function checkedDirectory(value: string) {
  const absolute = resolve(value);
  if (
    dirname(absolute) !== resolve(tmpdir()) ||
    !basename(absolute).startsWith(prefix)
  )
    throw new Error("Refusing cleanup outside the group rename fixture");
  return absolute;
}
beforeEach(() => {
  directory = checkedDirectory(mkdtempSync(join(tmpdir(), prefix)));
  path = join(directory, "fixture.sqlite");
  store = new Store(path, key);
  inspection = new Database(path);
  store.createSession(crypto.tokenHash(token), csrf);
  store.setMeta("adminHash", "fixture-admin-hash-unchanged");
  store.setMeta("unrelated", "fixture-meta-unchanged");
  vi.stubEnv("RELAYDOCK_PUBLIC_URL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  try {
    inspection?.close();
    store?.close();
  } finally {
    if (directory) {
      rmSync(checkedDirectory(directory), { recursive: true, force: true });
      expect(existsSync(directory)).toBe(false);
    }
  }
});
function add(
  name: string,
  group = "原分组",
  overrides: Record<string, unknown> = {},
) {
  return store.create({
    name,
    group,
    siteUrl: "https://fixture.invalid",
    apiUrl: "https://fixture.invalid",
    provider: "newapi",
    userId: "123",
    credential: `fixture-secret-${name}`,
    initialBalance: "12.75",
    ...overrides,
  });
}
function raw(id: string) {
  return inspection
    .prepare("SELECT id,payload,secret FROM accounts WHERE id=?")
    .get(id) as RawAccount;
}
function persisted() {
  return {
    accounts: inspection
      .prepare("SELECT * FROM accounts ORDER BY id")
      .all() as RawAccount[],
    snapshots: inspection.prepare("SELECT * FROM snapshots ORDER BY id").all(),
    meta: inspection.prepare("SELECT * FROM meta ORDER BY key").all(),
    sessions: inspection.prepare("SELECT * FROM sessions ORDER BY id").all(),
  };
}
const command = (
  name = "原分组",
  newName = "新分组",
  expectedRevision = store.groupLayout().revision,
) => ({ name, newName, expectedRevision });
function rename(input: unknown): RenameResult {
  // RED must be an assertion about the missing feature, not an import/TypeError.
  expect(store).toHaveProperty("renameGroup", expect.any(Function));
  return store.renameGroup(input);
}
function call(
  input: unknown,
  headers: Record<string, string> = {},
  method = "POST",
  route = ["map", "groups", "rename"],
  target = store,
) {
  return handleApi(
    new Request("http://localhost/api/" + route.join("/"), {
      method,
      headers: {
        origin: "http://localhost",
        cookie: "atlas_session=" + token,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...headers,
      },
      ...(!["GET", "HEAD"].includes(method)
        ? { body: JSON.stringify(input) }
        : {}),
    }),
    route,
    target,
  );
}
function geometry() {
  const map = layoutIslands(store.list(), store.groupLayout().positions);
  return {
    islands: map.islands
      .map(({ seed: _seed, ...island }) => island)
      .sort((a, b) => a.name.localeCompare(b.name)),
    nodes: map.nodes.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

it("renames all matching raw payloads including archived accounts without mixing IDs, balances or secrets", () => {
  const a = add("A", "原分组", { mapOrder: 8 }),
    b = add("B", "原分组", {
      archived: true,
      mapOrder: 2,
      initialBalance: "35.125",
    }),
    other = add("C", "原分组扩展", { initialBalance: "99" });
  store.record(a.id, "7.5", "sync", "USD", "fixture history", "3750000");
  for (const account of [a, b]) {
    const payload = JSON.parse(raw(account.id).payload);
    Object.assign(payload, {
      balance: "777",
      balanceUnit: "cached-unit",
      rawQuota: "888",
      futureMetadata: { owner: account.id, nested: ["opaque", 1, null] },
    });
    inspection
      .prepare("UPDATE accounts SET payload=? WHERE id=?")
      .run(JSON.stringify(payload), account.id);
  }
  const before = persisted(),
    publicBefore = store.list();
  const encrypt = vi.spyOn(crypto, "encryptSecret"),
    decrypt = vi.spyOn(crypto, "decryptSecret");
  const result = rename(command());
  expect(result.accounts.map((a) => a.id).sort()).toEqual([a.id, b.id].sort());
  for (const old of before.accounts) {
    const next = raw(old.id),
      payload = JSON.parse(next.payload),
      previous = JSON.parse(old.payload);
    expect(next.id).toBe(old.id);
    expect(next.secret).toBe(old.secret); // AES-GCM ciphertext must not be re-encrypted.
    if (old.id === other.id) expect(next).toEqual(old);
    else {
      expect(payload).toEqual({
        ...previous,
        group: "新分组",
        updatedAt: payload.updatedAt,
      });
      expect(Date.parse(payload.updatedAt)).toBeGreaterThan(
        Date.parse(previous.updatedAt),
      );
    }
    expect(store.get(old.id)).toEqual(
      old.id === other.id
        ? publicBefore.find((a) => a.id === old.id)
        : {
            ...publicBefore.find((a) => a.id === old.id),
            group: "新分组",
            updatedAt: payload.updatedAt,
          },
    );
  }
  expect(encrypt).not.toHaveBeenCalled();
  expect(decrypt).not.toHaveBeenCalled();
  expect(persisted().snapshots).toEqual(before.snapshots);
  expect(persisted().sessions).toEqual(before.sessions);
  expect(store.getMeta("adminHash")).toBe("fixture-admin-hash-unchanged");
  expect(store.getMeta("unrelated")).toBe("fixture-meta-unchanged");
  expect(store.history(a.id).every((s) => s.accountId === a.id)).toBe(true);
  expect(store.history(b.id).every((s) => s.accountId === b.id)).toBe(true);
  expect(store.credential(a.id)).toBe("fixture-secret-A");
  expect(store.credential(b.id)).toBe("fixture-secret-B");
});

it("POST returns affected public accounts and the new layout without querying or exposing credentials", async () => {
  const a = add("A"),
    b = add("B", "原分组", { archived: true });
  const query = vi
    .spyOn(queries, "queryBalance")
    .mockImplementation(async () => {
      throw new Error("A rename must never query a provider");
    });
  const response = await call(command(" 原分组 ", " 新分组 "));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text(),
    result = JSON.parse(text) as RenameResult;
  expect(result.accounts.map((a) => a.id).sort()).toEqual([a.id, b.id].sort());
  expect(
    result.accounts.every((a) => a.group === "新分组" && a.hasCredential),
  ).toBe(true);
  expect(result.groupLayout).toEqual(store.groupLayout());
  expect(result.groupLayout.revision).toBe(1);
  expect(text).not.toContain("fixture-secret");
  expect(text).not.toContain(raw(a.id).secret!);
  expect(query).not.toHaveBeenCalled();
});

it("freezes every current automatic island before renaming; adding a ninth group and reload never reorders them", () => {
  for (const group of ["A", "B", "C", "D", "E", "F", "G", "Z"])
    add(group, group, { archived: group === "G" });
  for (let i = 0; i < 10; i++) add("large-" + i, "B");
  const before = geometry();
  const result = rename(command("Z", "0"));
  expect(result.groupLayout.positions).toHaveLength(8);
  const expected = {
    islands: before.islands
      .map((i) => ({ ...i, name: i.name === "Z" ? "0" : i.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    nodes: before.nodes.map((n) => ({
      ...n,
      group: n.group === "Z" ? "0" : n.group,
    })),
  };
  expect(geometry()).toEqual(expected);
  const extra = add("new", "! added");
  const checkOriginal = () => {
    const map = geometry();
    expect(map.islands.filter((i) => i.name !== "! added")).toEqual(
      expected.islands,
    );
    expect(map.nodes.filter((n) => n.id !== extra.id)).toEqual(expected.nodes);
  };
  checkOriginal();
  store.close();
  store = new Store(path, key);
  checkOriginal();
});

it("renames an explicit coordinate exactly and freezes neighboring automatic and archived-only groups", () => {
  add("A");
  add("B", "备用");
  add("C", "归档", { archived: true });
  store.moveGroup({
    name: "原分组",
    position: { x: 721.125, y: 1630.875 },
    expectedRevision: 0,
  });
  store.moveGroup({
    name: "归档",
    position: { x: 1100, y: 410 },
    expectedRevision: 1,
  });
  const before = geometry();
  const { groupLayout } = rename(command());
  expect(groupLayout.revision).toBe(3);
  expect(groupLayout.positions).toContainEqual({
    name: "新分组",
    x: 721.125,
    y: 1630.875,
  });
  expect(groupLayout.positions).toContainEqual({
    name: "归档",
    x: 1100,
    y: 410,
  });
  expect(groupLayout.positions.some((p) => p.name === "原分组")).toBe(false);
  expect(geometry().nodes).toEqual(
    before.nodes.map((n) => ({
      ...n,
      group: n.group === "原分组" ? "新分组" : n.group,
    })),
  );
});

it("matches the map's 未分组 fallback for empty account.group and includes an archived-only source", () => {
  const a = add("empty", ""),
    b = add("default", "未分组", { archived: true });
  add("neighbor", "未分组扩展");
  expect(
    rename(command("未分组"))
      .accounts.map((a) => a.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
  const archived = add("archive", "仅归档", { archived: true });
  expect(rename(command("仅归档", "改后归档")).accounts).toEqual([
    store.get(archived.id),
  ]);
  expect(store.get(archived.id)?.archived).toBe(true);
});

it("enforces trimmed 50-character names in both rename directions and persists matching layout names", async () => {
  add("A");
  const long = "界".repeat(50);
  let response = await call(command("\t原分组\n", ` ${long} `));
  expect(response.status).toBe(200);
  expect(store.list()[0].group).toBe(long);
  expect(
    groupPositionSchema.safeParse({ name: long, x: 1, y: 1 }).success,
  ).toBe(true);
  expect(store.groupLayout()).toMatchObject({
    revision: 1,
    positions: [{ name: long }],
  });
  response = await call(command(` ${long} `, "回改"));
  expect(response.status).toBe(200);
  expect(store.list()[0].group).toBe("回改");
});

const longGroupOperations = [
  "backup restore",
  "ordinary edit",
  "account move",
  "batch group",
] as const;
it.each(
  [41, 50].flatMap((length) =>
    longGroupOperations.map((operation) => ({ length, operation })),
  ),
)(
  "long group compatibility: $length-character renamed group / $operation",
  async ({ length, operation }) => {
    const a = add("renamed", "原分组", { mapOrder: 7 }),
      b = add("incoming", "备用");
    // Prepare editor/import fixtures before the rename so export's own 40-char
    // validation cannot mask the independent edit/move/batch/import boundaries.
    const originalBackup = store.exportBackup();
    const longName = "界".repeat(length);
    const renamed = await call(command("原分组", longName));
    expect(renamed.status).toBe(200);
    expect(store.get(a.id)?.group).toBe(longName);
    const before = persisted();

    if (operation === "backup restore") {
      const backup = {
        ...originalBackup,
        accounts: originalBackup.accounts.map((account) => ({
          ...account,
          details: {
            ...account.details,
            group: account.id === a.id ? longName : account.details.group,
          },
        })),
        groupPositions: store.groupLayout().positions,
      };
      const restored = new Store(
        join(directory, "restore.sqlite"),
        Buffer.alloc(32, 30),
      );
      try {
        restored.createSession(crypto.tokenHash(token), csrf);
        const preview = await call(
          { backup, preview: true },
          {},
          "POST",
          ["backup", "import"],
          restored,
        );
        expect(preview.status).toBe(200);
        expect(restored.list()).toEqual([]);
        const response = await call(
          { backup, preview: false },
          {},
          "POST",
          ["backup", "import"],
          restored,
        );
        expect(response.status).toBe(200);
        expect(restored.get(a.id)).toMatchObject({
          id: a.id,
          group: longName,
          mapOrder: 7,
          balance: "12.75",
        });
        expect(restored.history()).toEqual(store.history());
        expect(restored.groupLayout().positions).toEqual(backup.groupPositions);
        expect(persisted()).toEqual(before);
      } finally {
        restored.close();
      }
    } else if (operation === "ordinary edit") {
      const details = originalBackup.accounts.find(
        (account) => account.id === a.id,
      )!.details;
      const current = store.get(a.id)!;
      const response = await call(
        {
          ...details,
          group: ` ${longName} `,
          alias: "edited after rename",
          expectedUpdatedAt: current.updatedAt,
        },
        {},
        "PATCH",
        ["accounts", a.id],
      );
      expect(response.status).toBe(200);
      expect(store.get(a.id)).toMatchObject({
        group: longName,
        alias: "edited after rename",
      });
      expect(Date.parse(store.get(a.id)!.updatedAt)).toBeGreaterThan(
        Date.parse(current.updatedAt),
      );
    } else if (operation === "account move") {
      const current = store.get(b.id)!;
      const response = await call(
        {
          id: b.id,
          group: ` ${longName} `,
          beforeId: a.id,
          expectedUpdatedAt: current.updatedAt,
        },
        {},
        "POST",
        ["accounts", "move"],
      );
      expect(response.status).toBe(200);
      expect(store.get(b.id)?.group).toBe(longName);
      expect(
        store
          .list()
          .filter((account) => account.group === longName)
          .sort((x, y) => x.mapOrder! - y.mapOrder!)
          .map((account) => account.id),
      ).toEqual([b.id, a.id]);
    } else {
      const response = await call(
        {
          ids: [b.id],
          operation: { kind: "group", group: ` ${longName} ` },
        },
        {},
        "POST",
        ["accounts", "batch"],
      );
      expect(response.status).toBe(200);
      expect(store.get(b.id)?.group).toBe(longName);
      expect(store.get(b.id)?.mapOrder).toBe(b.mapOrder);
    }
    expect(persisted().snapshots).toEqual(before.snapshots);
    for (const account of before.accounts)
      expect(raw(account.id).secret).toBe(account.secret);
  },
);

it.each([41, 50])(
  "long group compatibility: %i-character renamed group / backup export",
  async (length) => {
    const a = add("A"),
      longName = "界".repeat(length);
    expect((await call(command("原分组", longName))).status).toBe(200);
    const before = persisted();
    const response = await call(undefined, {}, "GET", ["backup", "export"]);
    expect(response.status).toBe(200);
    const backup = await response.json();
    expect(
      backup.accounts.find((account: { id: string }) => account.id === a.id)
        .details.group,
    ).toBe(longName);
    expect(backup.groupPositions).toEqual(store.groupLayout().positions);
    expect(backup.snapshots).toEqual(store.history());
    expect(persisted()).toEqual(before);
  },
);

it.each(longGroupOperations)(
  "long group boundary: rejects 51 characters atomically / %s",
  async (operation) => {
    const a = add("A"),
      longName = "界".repeat(51),
      before = persisted();
    const backup = store.exportBackup(),
      details = backup.accounts.find((account) => account.id === a.id)!.details;
    let response: Response;
    if (operation === "backup restore") {
      response = await call(
        {
          backup: {
            ...backup,
            accounts: backup.accounts.map((account) => ({
              ...account,
              details: { ...account.details, group: longName },
            })),
          },
          preview: false,
        },
        {},
        "POST",
        ["backup", "import"],
      );
    } else if (operation === "ordinary edit") {
      response = await call(
        {
          ...details,
          group: longName,
          expectedUpdatedAt: store.get(a.id)!.updatedAt,
        },
        {},
        "PATCH",
        ["accounts", a.id],
      );
    } else if (operation === "account move") {
      response = await call(
        {
          id: a.id,
          group: longName,
          beforeId: null,
          expectedUpdatedAt: store.get(a.id)!.updatedAt,
        },
        {},
        "POST",
        ["accounts", "move"],
      );
    } else {
      response = await call(
        { ids: [a.id], operation: { kind: "group", group: longName } },
        {},
        "POST",
        ["accounts", "batch"],
      );
    }
    expect(response.status).toBe(400);
    expect(persisted()).toEqual(before);
  },
);

it("keeps updatedAt strictly increasing across repeated renames even when the clock rolls back", () => {
  const a = add("A"),
    details = store.exportBackup().accounts[0].details;
  const payload = JSON.parse(raw(a.id).payload),
    future = "2099-01-01T00:00:00.000Z";
  inspection
    .prepare("UPDATE accounts SET payload=? WHERE id=?")
    .run(JSON.stringify({ ...payload, updatedAt: future }), a.id);
  const history = persisted().snapshots;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
  rename(command());
  expect(store.get(a.id)?.updatedAt).toBe("2099-01-01T00:00:00.001Z");
  rename(command("新分组", "再改"));
  expect(store.get(a.id)?.updatedAt).toBe("2099-01-01T00:00:00.002Z");
  expect(() =>
    store.update(a.id, { ...details, expectedUpdatedAt: future }),
  ).toThrow(/已被修改/);
  expect(persisted().snapshots).toEqual(history);
});

it("same trimmed source and target is a true no-op without freezing positions or changing timestamps/revision", async () => {
  const a = add("A");
  const before = persisted();
  expect(rename(command(" 原分组 ", "原分组")).accounts).toEqual([
    store.get(a.id),
  ]);
  const response = await call(command("原分组", " 原分组 "));
  expect(response.status).toBe(200);
  expect((await response.json()).groupLayout).toEqual({
    revision: 0,
    positions: [],
  });
  expect(persisted()).toEqual(before);
});

it("checks the current locked revision before both rename and no-op; another SQLite connection wins", async () => {
  add("A");
  const second = new Store(path, key);
  try {
    second.moveGroup({
      name: "原分组",
      position: { x: 100, y: 200 },
      expectedRevision: 0,
    });
    const before = persisted();
    for (const newName of ["新分组", "原分组"]) {
      expect(() => rename(command("原分组", newName, 0))).toThrow(
        expect.objectContaining({ status: 409 }),
      );
      const response = await call(command("原分组", newName, 0));
      expect(response.status).toBe(409);
      expect(await response.json()).toHaveProperty("error");
      expect(persisted()).toEqual(before);
    }
  } finally {
    second.close();
  }
});

it.each([false, true])(
  "rejects a target occupied by an account (archived=%s) instead of merging",
  async (archived) => {
    add("A");
    add("B", "新分组", { archived });
    const before = persisted();
    expect(() => rename(command())).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect((await call(command())).status).toBe(400);
    expect(persisted()).toEqual(before);
  },
);

it("rejects an orphan target coordinate even though the public layout filters it out", async () => {
  add("A");
  store.setMeta(
    "groupLayout",
    JSON.stringify({
      revision: 7,
      positions: [{ name: "新分组", x: 410, y: 630 }],
    }),
  );
  expect(store.groupLayout()).toEqual({ revision: 7, positions: [] });
  const before = persisted();
  expect(() => rename(command())).toThrow(
    expect.objectContaining({ status: 400 }),
  );
  expect((await call(command())).status).toBe(400);
  expect(persisted()).toEqual(before);
});

it.each(["新分组", "missing"])(
  "rejects an absent source, even for same-name no-op (%s)",
  async (newName) => {
    add("A");
    store.setMeta(
      "groupLayout",
      JSON.stringify({
        revision: 4,
        positions: [{ name: "missing", x: 40, y: 60 }],
      }),
    );
    const before = persisted();
    expect(() => rename(command("missing", newName))).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect((await call(command("missing", newName))).status).toBe(400);
    expect(persisted()).toEqual(before);
  },
);

it.each([
  ["blank source", { name: " \t " }],
  ["blank target", { newName: " \n " }],
  ["long source", { name: "x".repeat(51) }],
  ["long target", { newName: "x".repeat(51) }],
  ["source type", { name: 1 }],
  ["target type", { newName: null }],
  ["negative revision", { expectedRevision: -1 }],
  ["fractional revision", { expectedRevision: 0.5 }],
  ["string revision", { expectedRevision: "0" }],
  ["overflow revision", { expectedRevision: Number.MAX_SAFE_INTEGER }],
  ["extra credential", { credential: "fixture-injected-secret" }],
  ["extra position", { position: { x: 1, y: 2 } }],
  ["missing source", { name: undefined }],
  ["missing target", { newName: undefined }],
  ["missing revision", { expectedRevision: undefined }],
])("strictly rejects malformed input atomically: %s", async (_label, patch) => {
  add("A");
  const before = persisted(),
    input = { ...command(), ...patch };
  expect(() => rename(input)).toThrow(expect.objectContaining({ status: 400 }));
  const response = await call(input);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("fixture-injected-secret");
  expect(persisted()).toEqual(before);
});

it("requires the existing administrator session, origin and CSRF; GET cannot rename", async () => {
  add("A");
  const before = persisted();
  for (const [headers, status] of [
    [{ cookie: "" }, 401],
    [{ "x-csrf-token": "" }, 403],
    [{ "x-csrf-token": "c".repeat(48) }, 403],
    [{ origin: "https://evil.invalid" }, 403],
    [{ origin: "" }, 403],
  ] as [Record<string, string>, number][]) {
    expect((await call(command(), headers)).status).toBe(status);
    expect(persisted()).toEqual(before);
  }
  expect((await call(command(), {}, "GET")).status).toBe(404);
  expect(persisted()).toEqual(before);
});

it.each(["account", "layout"])(
  "rolls back all accounts and coordinates on a later %s write failure, with sanitized errors",
  async (target) => {
    add("A");
    const b = add("B", "原分组", { archived: true });
    store.moveGroup({
      name: "原分组",
      position: { x: 640, y: 410 },
      expectedRevision: 0,
    });
    inspection.exec(
      target === "account"
        ? `CREATE TRIGGER rename_fail BEFORE UPDATE ON accounts WHEN OLD.id='${b.id}' BEGIN SELECT RAISE(ABORT, 'fixture-secret-sql-failure'); END`
        : "CREATE TRIGGER rename_fail BEFORE UPDATE ON meta WHEN OLD.key='groupLayout' BEGIN SELECT RAISE(ABORT, 'fixture-secret-sql-failure'); END",
    );
    const before = persisted();
    expect(() => rename(command())).toThrow(
      expect.objectContaining({ name: "GroupLayoutError", status: 500 }),
    );
    expect(persisted()).toEqual(before);
    const response = await call(command());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "分组改名失败；未修改账号或布局",
    });
    expect(persisted()).toEqual(before);
  },
);
