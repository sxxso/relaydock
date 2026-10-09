import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { QueryFailure, QueryTrace } from "../src/lib/query-trace";
import type { Account, Snapshot } from "../src/lib/validation";

const prefix = "relaydock-batch-test-";
const key = Buffer.alloc(32, 17);
const token = "a".repeat(64),
  csrf = "b".repeat(48);
const secret = "batch-fixture-only-secret";
const invalid = "批量命令无效，请检查账号和操作参数";
const missing = "批量账号不存在；未修改任何账号";
const overflow = "批量操作会使标签超过 12 个；未修改任何账号";
const failed = "批量修改失败；未修改任何账号";
const busy = "所选账号正在查询，请等待完成后批量修改";
let directory: string,
  path: string,
  store: Store,
  inspection: Database.Database;

function checkedDirectory(value: string) {
  const absolute = resolve(value);
  if (
    dirname(absolute) !== resolve(tmpdir()) ||
    !basename(absolute).startsWith(prefix)
  )
    throw new Error("Refusing cleanup outside the batch fixture directory");
  return absolute;
}
beforeEach(() => {
  directory = checkedDirectory(mkdtempSync(join(tmpdir(), prefix)));
  path = join(directory, "fixture.sqlite");
  store = new Store(path, key);
  inspection = new Database(path);
  store.createSession(tokenHash(token), csrf);
  vi.stubEnv("RELAYDOCK_PUBLIC_URL", "");
  vi.stubEnv("RELAYDOCK_PRIVATE_HOSTS", "127.0.0.1");
  vi.stubEnv("RELAYDOCK_DNS_MODE", "system");
});
afterEach(() => {
  try {
    inspection?.close();
    store?.close();
  } finally {
    vi.unstubAllEnvs();
    if (directory) {
      rmSync(checkedDirectory(directory), { recursive: true, force: true });
      expect(existsSync(directory)).toBe(false);
    }
  }
});

function create(overrides: Record<string, unknown> = {}) {
  return store.create({
    name: "batch fixture",
    siteUrl: "https://batch.example",
    group: "原分组",
    tags: ["base", "keep"],
    ...overrides,
  });
}
function diagnostic(operation: "test" | "sync", failure = false) {
  return new QueryTrace({
    provider: "newapi",
    operation,
    timeoutSeconds: 10,
    dnsMode: "system",
  }).finish(failure ? new QueryFailure("response_timeout", secret) : undefined);
}
function richAccount() {
  const account = create({
    provider: "newapi",
    credential: secret,
    alias: "保留别名",
    notes: "保留笔记",
    favorite: true,
    lowThreshold: "2.5",
    userId: "123",
    quotaPerUnit: "500000",
    apiUrl: "https://api.batch.example",
    managementUrl: "https://manage.batch.example",
    consoleUrl: "https://batch.example/console",
    rechargeUrl: "https://batch.example/pay",
    docsUrl: "https://batch.example/docs",
    query: { timeoutSeconds: 20 },
  });
  store.record(
    account.id,
    "12345678901234567890.125",
    "sync",
    "USD",
    "接口记录",
    "6172839450617283945062500",
    diagnostic("sync"),
  );
  store.record(account.id, "0", "manual", "USD", "手动零值");
  store.syncFailure(account.id, secret, diagnostic("sync", true));
  store.saveQueryDiagnostic(account.id, diagnostic("test"));
  // The preferred balance snapshot is not the chronological latest snapshot.
  const future: Snapshot = {
    ...store.history(account.id)[0],
    id: randomUUID(),
    amount: "999",
    at: "2099-01-01T00:00:00.000Z",
    recordOrder: 3,
  };
  inspection
    .prepare(
      "INSERT INTO snapshots(id,account_id,payload,at,at_ms,record_order) VALUES(?,?,?,?,?,?)",
    )
    .run(
      future.id,
      future.accountId,
      JSON.stringify(future),
      future.at,
      Date.parse(future.at),
      future.recordOrder,
    );
  const payload = JSON.parse(raw(account.id).payload);
  payload.updatedAt = "2020-01-01T00:00:00.000Z";
  payload.balance = "777";
  payload.balanceUnit = "cached-unit";
  payload.rawQuota = "888";
  payload.futureMetadata = { preserved: ["opaque", 1] };
  inspection
    .prepare("UPDATE accounts SET payload=? WHERE id=?")
    .run(JSON.stringify(payload), account.id);
  return store.get(account.id)!;
}
function raw(id: string) {
  return inspection
    .prepare("SELECT id,payload,secret FROM accounts WHERE id=?")
    .get(id) as {
    id: string;
    payload: string;
    secret: string | null;
  };
}
function persisted() {
  return {
    accounts: inspection.prepare("SELECT * FROM accounts ORDER BY id").all(),
    snapshots: inspection.prepare("SELECT * FROM snapshots ORDER BY id").all(),
    meta: inspection.prepare("SELECT * FROM meta ORDER BY key").all(),
    sessions: inspection.prepare("SELECT * FROM sessions ORDER BY id").all(),
  };
}
function batch(input: unknown): Account[] {
  // RED is an assertion about the missing feature, not an import/TypeError.
  expect(store).toHaveProperty("batchUpdate", expect.any(Function));
  return store.batchUpdate(input);
}
function call(
  input: unknown,
  headers: Record<string, string> = {},
  method = "POST",
  route = ["accounts", "batch"],
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
    store,
  );
}
async function rejected(
  target: "Store" | "API",
  input: unknown,
  error: string,
) {
  if (target === "Store") expect(() => batch(input)).toThrow(error);
  else {
    const response = await call(input);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  }
}
function preserved(
  id: string,
  before: ReturnType<typeof raw>,
  change: Record<string, unknown>,
) {
  const next = raw(id),
    payload = JSON.parse(next.payload),
    old = JSON.parse(before.payload);
  expect(payload).toEqual({ ...old, ...change, updatedAt: expect.any(String) });
  expect(Date.parse(payload.updatedAt)).toBeGreaterThan(
    Date.parse(old.updatedAt),
  );
  expect(next.secret).toBe(before.secret);
  expect(store.credential(id)).toBe(secret);
}

describe("Store metadata-only transactions", () => {
  it("groups in input order without rewriting ciphertext, balances, pointers, diagnostics or other metadata", () => {
    const a = richAccount(),
      b = richAccount(),
      untouched = create();
    store.setSettings({ theme: "dark", motion: false, mapBackground: "grid" });
    const before = persisted(),
      first = raw(a.id),
      second = raw(b.id),
      other = raw(untouched.id);
    // Even an UPDATE assigning the same ciphertext is forbidden.
    inspection.exec(
      "CREATE TRIGGER reject_secret_update BEFORE UPDATE OF secret ON accounts BEGIN SELECT RAISE(ABORT,'secret column must not be written'); END",
    );
    const result = batch({
      ids: [b.id, a.id],
      operation: { kind: "group", group: "  新分组  " },
    });
    expect(result).toEqual([store.get(b.id), store.get(a.id)]);
    expect(result.map((x) => x.group)).toEqual(["新分组", "新分组"]);
    expect(
      result.every(
        (x) =>
          x.balance === "0" && x.balanceSource === "manual" && x.hasCredential,
      ),
    ).toBe(true);
    expect(result[0].updatedAt).toBe(result[1].updatedAt);
    expect(JSON.stringify(result)).not.toContain(secret);
    preserved(a.id, first, { group: "新分组" });
    preserved(b.id, second, { group: "新分组" });
    expect(raw(untouched.id)).toEqual(other);
    const after = persisted();
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.meta).toEqual(before.meta);
    expect(after.sessions).toEqual(before.sessions);
  });
  it.each([
    [
      "add",
      [" extra ", "base", "extra", " third "],
      ["base", "keep", "extra", "third"],
    ],
    ["remove", [" base ", "base", "absent"], ["keep"]],
    ["replace", [" new ", "base", "new"], ["new", "base"]],
    ["replace", [], []],
  ] as const)(
    "applies %s with trimmed, stable deduplication and keeps non-tag fields",
    (mode, tags, expected) => {
      const a = richAccount(),
        before = raw(a.id),
        history = store.history();
      const result = batch({
        ids: [a.id],
        operation: { kind: "tags", mode, tags: [...tags] },
      });
      expect(result[0].tags).toEqual([...expected]);
      preserved(a.id, before, { tags: [...expected] });
      expect(store.history()).toEqual(history);
    },
  );
  it.each([true, false])(
    "sets archived=%s without changing any other saved account field",
    (archived) => {
      const a = richAccount(),
        before = raw(a.id),
        history = store.history();
      const result = batch({
        ids: [a.id],
        operation: { kind: "archive", archived },
      });
      expect(result[0].archived).toBe(archived);
      preserved(a.id, before, { archived });
      expect(store.history()).toEqual(history);
    },
  );
  it("accepts exactly 40 trimmed group characters and 12 tags of 24 trimmed characters", () => {
    const a = create();
    expect(
      batch({
        ids: [a.id],
        operation: { kind: "group", group: " " + "组".repeat(50) + " " },
      })[0].group,
    ).toHaveLength(50);
    const tags = Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(24, "x"));
    expect(
      batch({
        ids: [a.id],
        operation: {
          kind: "tags",
          mode: "replace",
          tags: tags.map((x) => ` ${x} `),
        },
      })[0].tags,
    ).toEqual(tags);
    expect(
      batch({
        ids: [a.id],
        operation: { kind: "tags", mode: "add", tags: [tags[0]] },
      })[0].tags,
    ).toEqual(tags);
  });
});

const invalidCommands: { name: string; input: (ids: string[]) => unknown }[] = [
  { name: "missing command", input: () => null },
  {
    name: "missing ids",
    input: () => ({ operation: { kind: "archive", archived: true } }),
  },
  {
    name: "empty ids",
    input: () => ({ ids: [], operation: { kind: "archive", archived: true } }),
  },
  {
    name: "non-array ids",
    input: (ids) => ({
      ids: ids[0],
      operation: { kind: "archive", archived: true },
    }),
  },
  {
    name: "non-UUID id",
    input: (ids) => ({
      ids: [...ids, secret],
      operation: { kind: "archive", archived: true },
    }),
  },
  {
    name: "non-string id",
    input: (ids) => ({
      ids: [...ids, 1],
      operation: { kind: "archive", archived: true },
    }),
  },
  {
    name: "duplicate ids",
    input: (ids) => ({
      ids: [...ids, ids[0]],
      operation: { kind: "archive", archived: true },
    }),
  },
  {
    name: "case-equivalent duplicate ids",
    input: (ids) => ({
      ids: [...ids, ids[0].toUpperCase()],
      operation: { kind: "archive", archived: true },
    }),
  },
  {
    name: "extra credential field",
    input: (ids) => ({
      ids,
      credential: secret,
      operation: { kind: "archive", archived: true },
    }),
  },
  { name: "missing operation", input: (ids) => ({ ids }) },
  {
    name: "unsupported operation",
    input: (ids) => ({ ids, operation: { kind: "delete" } }),
  },
  {
    name: "missing group",
    input: (ids) => ({ ids, operation: { kind: "group" } }),
  },
  {
    name: "blank group",
    input: (ids) => ({ ids, operation: { kind: "group", group: " \t " } }),
  },
  {
    name: "long group",
    input: (ids) => ({
      ids,
      operation: { kind: "group", group: "x".repeat(51) },
    }),
  },
  {
    name: "non-string group",
    input: (ids) => ({ ids, operation: { kind: "group", group: 1 } }),
  },
  {
    name: "group extra metadata",
    input: (ids) => ({
      ids,
      operation: { kind: "group", group: "ok", balance: secret },
    }),
  },
  {
    name: "missing archived",
    input: (ids) => ({ ids, operation: { kind: "archive" } }),
  },
  {
    name: "coerced archived",
    input: (ids) => ({ ids, operation: { kind: "archive", archived: "true" } }),
  },
  {
    name: "archive extra credential",
    input: (ids) => ({
      ids,
      operation: { kind: "archive", archived: true, credential: secret },
    }),
  },
  {
    name: "unknown tag mode",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "merge", tags: ["a"] },
    }),
  },
  {
    name: "missing tags",
    input: (ids) => ({ ids, operation: { kind: "tags", mode: "replace" } }),
  },
  {
    name: "non-array tags",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "replace", tags: "a" },
    }),
  },
  {
    name: "non-string tag",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "replace", tags: [1] },
    }),
  },
  {
    name: "blank tag",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "replace", tags: [" \t "] },
    }),
  },
  {
    name: "long tag",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "replace", tags: ["x".repeat(25)] },
    }),
  },
  {
    name: "13 tags",
    input: (ids) => ({
      ids,
      operation: {
        kind: "tags",
        mode: "replace",
        tags: Array.from({ length: 13 }, (_, i) => `${i}`),
      },
    }),
  },
  {
    name: "13 duplicate tags",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "replace", tags: Array(13).fill("a") },
    }),
  },
  {
    name: "empty add",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "add", tags: [] },
    }),
  },
  {
    name: "empty remove",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "remove", tags: [] },
    }),
  },
  {
    name: "tags extra metadata",
    input: (ids) => ({
      ids,
      operation: { kind: "tags", mode: "replace", tags: [], notes: secret },
    }),
  },
];
describe.each(["Store", "API"] as const)(
  "%s rejects entire invalid batches",
  (target) => {
    it.each(invalidCommands)(
      "rejects $name with a fixed error and no writes",
      async ({ input }) => {
        const a = create({ credential: secret, initialBalance: "0" }),
          b = create(),
          before = persisted();
        await rejected(target, input([a.id, b.id]), invalid);
        expect(persisted()).toEqual(before);
      },
    );
    it.each(["first", "last"])(
      "rejects an unknown %s ID before any update",
      async (position) => {
        const a = create(),
          b = create(),
          unknown = randomUUID(),
          before = persisted();
        const ids =
          position === "first" ? [unknown, a.id, b.id] : [a.id, b.id, unknown];
        inspection.exec(
          "CREATE TRIGGER reject_any_update BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'must preflight all ids'); END",
        );
        await rejected(
          target,
          { ids, operation: { kind: "archive", archived: true } },
          missing,
        );
        expect(persisted()).toEqual(before);
      },
    );
    it("preflights tag union overflow on a later account before attempting any update", async () => {
      const a = create({ tags: ["base"] }),
        b = create({ tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`) });
      const before = persisted();
      inspection.exec(
        "CREATE TRIGGER reject_any_update BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'must preflight all tags'); END",
      );
      await rejected(
        target,
        {
          ids: [a.id, b.id],
          operation: { kind: "tags", mode: "add", tags: ["extra"] },
        },
        overflow,
      );
      expect(persisted()).toEqual(before);
    });
    it("accepts 500 real IDs in order, but rejects 501 without even rewriting updatedAt", async () => {
      const ids = Array.from(
        { length: 501 },
        (_, i) => create({ name: `fixture-${i}` }).id,
      );
      const input = {
        ids: ids.slice(0, 500).reverse(),
        operation: { kind: "group", group: "500" },
      };
      let accounts: Account[];
      if (target === "Store") accounts = batch(input);
      else {
        const response = await call(input);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(Object.keys(body)).toEqual(["accounts"]);
        accounts = body.accounts;
      }
      expect(accounts.map((x) => x.id)).toEqual(input.ids);
      expect(accounts.every((x) => x.group === "500")).toBe(true);
      expect(store.get(ids[500])?.group).toBe("原分组");
      const before = persisted();
      await rejected(target, { ...input, ids }, invalid);
      expect(persisted()).toEqual(before);
    }, 15000);
    it("rolls back earlier writes on a real SQLite trigger failure, hides failure text, and releases the transaction", async () => {
      const a = richAccount(),
        b = richAccount(),
        before = persisted();
      inspection.exec(
        `CREATE TRIGGER reject_second BEFORE UPDATE OF payload ON accounts WHEN NEW.id='${b.id}' BEGIN SELECT RAISE(ABORT,'${secret}'); END`,
      );
      const input = {
        ids: [a.id, b.id],
        operation: { kind: "group", group: "回滚测试" },
      };
      if (target === "Store") expect(() => batch(input)).toThrow(failed);
      else {
        const response = await call(input);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: failed });
      }
      expect(persisted()).toEqual(before);
      inspection.exec("DROP TRIGGER reject_second");
      if (target === "Store")
        expect(batch(input).map((x) => x.group)).toEqual([
          "回滚测试",
          "回滚测试",
        ]);
      else expect((await call(input)).status).toBe(200);
    });
  },
);

describe("authenticated batch API", () => {
  it.each([
    { kind: "group", group: "  API分组  " },
    { kind: "tags", mode: "add", tags: [" third ", "base", "third"] },
    { kind: "tags", mode: "remove", tags: [" base ", "absent"] },
    { kind: "tags", mode: "replace", tags: [" new ", "base", "new"] },
    { kind: "tags", mode: "replace", tags: [] },
    { kind: "archive", archived: true },
    { kind: "archive", archived: false },
  ])(
    "routes $kind before account/{id} and returns only public accounts",
    async (operation) => {
      const a = richAccount(),
        b = create({ archived: true, initialBalance: "0" });
      const response = await call({ ids: [b.id, a.id], operation });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({ accounts: [store.get(b.id), store.get(a.id)] });
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(body.accounts[1].balance).toBe("0");
      if (operation.kind === "group")
        expect(body.accounts[1].group).toBe("API分组");
      if (operation.kind === "archive")
        expect(body.accounts[1].archived).toBe(operation.archived);
      if (operation.kind === "tags") {
        const expected =
          operation.mode === "add"
            ? ["base", "keep", "third"]
            : operation.mode === "remove"
              ? ["keep"]
              : operation.tags!.length
                ? ["new", "base"]
                : [];
        expect(body.accounts[1].tags).toEqual(expected);
      }
    },
  );
  it.each([
    [{ cookie: "" }, 401, "请先登录"],
    [{ cookie: "atlas_session=" + "c".repeat(64) }, 401, "请先登录"],
    [{ "x-csrf-token": "" }, 403, "安全校验失效，请刷新页面重试"],
    [{ "x-csrf-token": "d".repeat(48) }, 403, "安全校验失效，请刷新页面重试"],
    [{ "x-csrf-token": "é".repeat(48) }, 403, "安全校验失效，请刷新页面重试"],
    [{ origin: "https://evil.example" }, 403, "请求来源不被允许"],
    [{ origin: "" }, 403, "请求来源不被允许"],
  ] as const)(
    "denies unauthenticated or failed origin/CSRF requests without writes (%s)",
    async (headers, status, error) => {
      const a = create(),
        before = persisted();
      const response = await call(
        { ids: [a.id], operation: { kind: "archive", archived: true } },
        headers,
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(persisted()).toEqual(before);
    },
  );
  it.each(["GET", "PATCH", "DELETE"])(
    "does not expose batch mutations via %s",
    async (method) => {
      const a = create(),
        before = persisted();
      expect(
        (
          await call(
            { ids: [a.id], operation: { kind: "archive", archived: true } },
            {},
            method,
          )
        ).status,
      ).toBe(404);
      expect(persisted()).toEqual(before);
    },
  );
  it("persists batch metadata, exact ciphertext, snapshots and diagnostics after a reopen", async () => {
    const a = richAccount(),
      b = create({ credential: secret }),
      ids = [b.id, a.id];
    for (const operation of [
      { kind: "group", group: "重启分组" },
      { kind: "tags", mode: "replace", tags: [" restart ", "restart", "kept"] },
      { kind: "archive", archived: true },
    ])
      expect((await call({ ids, operation })).status).toBe(200);
    const before = persisted(),
      publicBefore = store.list();
    inspection.close();
    store.close();
    store = new Store(path, key);
    inspection = new Database(path);
    expect(persisted()).toEqual(before);
    expect(store.list()).toEqual(publicBefore);
    expect(ids.map((id) => store.credential(id))).toEqual([secret, secret]);
    expect(store.get(a.id)).toMatchObject({
      group: "重启分组",
      tags: ["restart", "kept"],
      archived: true,
      balance: "0",
      lastSyncStatus: "error",
    });
    expect(
      (await call({ ids, operation: { kind: "archive", archived: false } }))
        .status,
    ).toBe(200);
  });
  it.each(["sync", "test"])(
    "rejects a whole batch while a real %s is hung, without extra provider queries, then releases busy",
    async (action) => {
      let hits = 0,
        held: ServerResponse | undefined;
      const server = createServer((_request, response) => {
        hits++;
        response.setHeader("Content-Type", "application/json");
        held = response;
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const root =
        "http://127.0.0.1:" + (server.address() as { port: number }).port;
      const a = create({
        siteUrl: root,
        provider: "custom",
        credential: secret,
        query: { path: "/hold" },
        initialBalance: "8.5",
      });
      const b = create({ initialBalance: "0" }),
        before = persisted();
      const first = call(undefined, {}, "POST", ["accounts", a.id, action]);
      try {
        await vi.waitFor(() => expect(held).toBeDefined(), {
          timeout: 2500,
          interval: 10,
        });
        const operations = [
          { kind: "group", group: "blocked" },
          { kind: "tags", mode: "add", tags: ["blocked"] },
          { kind: "tags", mode: "remove", tags: ["base"] },
          { kind: "tags", mode: "replace", tags: [] },
          { kind: "archive", archived: true },
          { kind: "archive", archived: false },
        ];
        for (const [index, operation] of operations.entries()) {
          const response = await call({
            ids: index % 2 ? [a.id, b.id] : [b.id, a.id],
            operation,
          });
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({ error: busy });
          expect(persisted()).toEqual(before);
          expect(hits).toBe(1);
        }
        expect(
          (
            await call({
              ids: [b.id],
              operation: { kind: "group", group: "allowed" },
            })
          ).status,
        ).toBe(200);
        expect(hits).toBe(1);
        held!.end(JSON.stringify({ balance: "25" }));
        expect((await first).status).toBe(200);
        expect(
          (
            await call({
              ids: [b.id, a.id],
              operation: { kind: "group", group: "released" },
            })
          ).status,
        ).toBe(200);
        expect(store.get(a.id)?.balance).toBe(action === "sync" ? "25" : "8.5");
        expect(hits).toBe(1);
      } finally {
        held?.end(JSON.stringify({ balance: "25" }));
        server.closeAllConnections();
        await first;
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
    15000,
  );
});
