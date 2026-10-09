import { beforeEach, afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { QueryTrace, QueryFailure } from "../src/lib/query-trace";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";

let dir: string, path: string, store: Store;
const key = Buffer.alloc(32, 9);
const input = {
  name: "记录夹具",
  siteUrl: "https://fixture.example",
  provider: "newapi",
  unit: "USD",
};
const diagnostic = (operation: "test" | "sync", failed = false) =>
  new QueryTrace({
    provider: "newapi",
    operation,
    timeoutSeconds: 10,
    dnsMode: "system",
  }).finish(
    failed ? new QueryFailure("response_timeout", "private text") : undefined,
  );
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-freshness-"));
  path = join(dir, "test.sqlite");
  store = new Store(path, key);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("exposes unknown separately from an explicitly recorded manual zero", () => {
  const a = store.create(input);
  expect(store.get(a.id)).toMatchObject({
    balance: null,
    balanceSource: null,
    lastSnapshotAt: null,
  });
  store.record(a.id, "0", "manual", "USD", "");
  expect(store.get(a.id)).toMatchObject({
    balance: "0",
    balanceSource: "manual",
  });
  expect(store.list()[0]).toMatchObject({
    balance: "0",
    balanceSource: "manual",
  });
});
it("uses the snapshot, not platform or most recent connection test, as provenance", () => {
  const a = store.create({ ...input, initialBalance: "4" });
  const before = store.get(a.id)!;
  store.saveQueryDiagnostic(a.id, diagnostic("test"));
  expect(store.get(a.id)).toMatchObject({
    balanceSource: "manual",
    lastSnapshotAt: before.lastSnapshotAt,
    lastSyncStatus: "never",
  });
  store.record(a.id, "3.25", "sync", "USD", "");
  store.saveQueryDiagnostic(a.id, diagnostic("sync"));
  const synced = store.get(a.id)!;
  const failure = diagnostic("sync", true);
  store.saveQueryDiagnostic(a.id, failure);
  store.syncFailure(a.id, "等待响应超时", failure);
  store.saveQueryDiagnostic(a.id, diagnostic("test"));
  expect(store.get(a.id)).toMatchObject({
    balance: "3.25",
    balanceSource: "sync",
    lastSnapshotAt: synced.lastSnapshotAt,
    lastSyncStatus: "error",
    lastSyncDiagnostic: failure,
  });
  expect(store.history(a.id)).toHaveLength(2);
  store.record(a.id, "2", "manual", "USD", "修正");
  expect(store.get(a.id)).toMatchObject({
    balanceSource: "manual",
    lastSyncStatus: "error",
    lastSyncDiagnostic: failure,
  });
  store.close();
  store = new Store(path, key);
  expect(store.get(a.id)).toMatchObject({
    balance: "2",
    balanceSource: "manual",
    lastSyncStatus: "error",
    lastSyncDiagnostic: failure,
  });
});
it("keeps provenance through metadata edits, archive and restart", () => {
  const a = store.create({ ...input, initialBalance: "0" });
  store.update(a.id, { ...input, archived: true, unit: "CNY" });
  store.close();
  store = new Store(path, key);
  expect(store.get(a.id)).toMatchObject({
    balance: "0",
    balanceUnit: "USD",
    balanceSource: "manual",
    archived: true,
  });
});
it.each([1, 2])(
  "reconstructs source from sanitized version %s backups, excluding diagnosis",
  (version) => {
    const a = store.create(input);
    store.record(a.id, "17", "sync", "USD", "");
    store.saveQueryDiagnostic(a.id, diagnostic("sync", true));
    const backup = { ...store.exportBackup(), version };
    expect(JSON.stringify(backup)).not.toContain("Diagnostic");
    expect(JSON.stringify(backup)).not.toContain("balanceSource");
    const other = new Store(join(dir, "restored.sqlite"), key);
    try {
      other.importBackup(backup, true);
      expect(other.list()).toHaveLength(0);
      other.importBackup(backup, false);
      expect(other.get(a.id)).toMatchObject({
        balance: "17",
        balanceSource: "sync",
        lastSnapshotAt: store.get(a.id)!.lastSnapshotAt,
      });
      expect(other.get(a.id)!.lastSyncDiagnostic ?? null).toBeNull();
    } finally {
      other.close();
    }
  },
);
it("reads pre-stage3 payloads from their real snapshot, without rewriting them", () => {
  const a = store.create(input);
  store.record(a.id, "9", "sync", "USD", "");
  const db = new Database(path);
  try {
    const raw = JSON.parse(
      (
        db.prepare("SELECT payload FROM accounts WHERE id=?").get(a.id) as {
          payload: string;
        }
      ).payload,
    );
    delete raw.balanceSource;
    delete raw.lastSyncDiagnostic;
    db.prepare("UPDATE accounts SET payload=? WHERE id=?").run(
      JSON.stringify(raw),
      a.id,
    );
    const before = db
      .prepare("SELECT payload FROM accounts WHERE id=?")
      .get(a.id);
    expect(store.get(a.id)).toMatchObject({
      balance: "9",
      balanceSource: "sync",
    });
    expect(
      db.prepare("SELECT payload FROM accounts WHERE id=?").get(a.id),
    ).toEqual(before);
  } finally {
    db.close();
  }
});
it("does not guess source for a legacy cached balance without any snapshot", () => {
  const a = store.create(input),
    db = new Database(path);
  try {
    const raw = JSON.parse(
      (
        db.prepare("SELECT payload FROM accounts WHERE id=?").get(a.id) as {
          payload: string;
        }
      ).payload,
    );
    Object.assign(raw, {
      balance: "6",
      lastSnapshotAt: "2026-01-01T00:00:00.000Z",
    });
    db.prepare("UPDATE accounts SET payload=? WHERE id=?").run(
      JSON.stringify(raw),
      a.id,
    );
    expect(store.get(a.id)).toMatchObject({
      balance: "6",
      balanceSource: null,
      lastSnapshotAt: null,
    });
  } finally {
    db.close();
  }
});
it("retains tie precedence when a partial restore is later merged with the full backup", () => {
  const a = store.create(input);
  store.record(a.id, "1", "manual", "USD", "older");
  store.record(a.id, "2", "sync", "USD", "latest");
  const backup = store.exportBackup();
  backup.snapshots = backup.snapshots.map((s) => ({
    ...s,
    at: "2026-10-03T00:00:00.000Z",
  }));
  const other = new Store(join(dir, "partial.sqlite"), key);
  try {
    other.importBackup({ ...backup, snapshots: [backup.snapshots[0]] }, false);
    other.importBackup(backup, false);
    expect(other.get(a.id)).toMatchObject({
      balance: "2",
      balanceSource: "sync",
    });
    other.importBackup(backup, false);
    expect(other.history(a.id)[0].amount).toBe("2");
  } finally {
    other.close();
  }
});
it("preserves v3 ordinals when merging an old partial v2 backup without them", () => {
  const a = store.create(input);
  store.record(a.id, "1", "manual", "USD", "");
  store.record(a.id, "2", "sync", "USD", "");
  const backup = store.exportBackup();
  backup.snapshots = backup.snapshots.map((s) => ({
    ...s,
    at: "2026-10-03T00:00:00.000Z",
    id:
      s.amount === "2"
        ? "00000000-0000-4000-8000-000000000001"
        : "ffffffff-ffff-4fff-8fff-ffffffffffff",
  }));
  const restored = new Store(join(dir, "old-merge.sqlite"), key);
  backup.accounts = backup.accounts.map((a) => ({
    ...a,
    balanceSnapshotId: "00000000-0000-4000-8000-000000000001",
  }));
  try {
    restored.importBackup(backup, false);
    const { recordOrder, ...latest } = backup.snapshots[0];
    void recordOrder;
    restored.importBackup(
      { ...backup, version: 2, snapshots: [latest] },
      false,
    );
    expect(restored.get(a.id)).toMatchObject({
      balance: "2",
      balanceSource: "sync",
    });
    expect(() =>
      restored.importBackup(restored.exportBackup(), true),
    ).not.toThrow();
  } finally {
    restored.close();
  }
});
it("adds an older tied legacy snapshot below an existing newer anchor", () => {
  const a = store.create(input);
  store.record(a.id, "1", "manual", "USD", "");
  store.record(a.id, "2", "sync", "USD", "");
  const backup = { ...store.exportBackup(), version: 2 };
  const snapshots = backup.snapshots.map((s) => {
    const { recordOrder, ...old } = s;
    void recordOrder;
    return { ...old, at: "2026-10-03T00:00:00.000Z" };
  });
  const restored = new Store(join(dir, "old-full.sqlite"), key);
  const accounts = backup.accounts.map((a) => {
    const { balanceSnapshotId, ...old } = a;
    void balanceSnapshotId;
    return old;
  });
  const oldBackup = { ...backup, accounts, snapshots };
  try {
    restored.importBackup({ ...oldBackup, snapshots: [snapshots[0]] }, false);
    restored.importBackup(oldBackup, false);
    expect(restored.get(a.id)).toMatchObject({
      balance: "2",
      balanceSource: "sync",
    });
    expect(() =>
      restored.importBackup(restored.exportBackup(), true),
    ).not.toThrow();
  } finally {
    restored.close();
  }
});
it.each([true, false])(
  "rejects a v3 ordering collision against existing snapshots without mutation (preview=%s)",
  (preview) => {
    const a = store.create({ ...input, initialBalance: "5" });
    const backup = store.exportBackup(),
      before = store.exportBackup();
    const conflicting = {
      ...backup,
      snapshots: [
        {
          ...backup.snapshots[0],
          id: "00000000-0000-4000-8000-000000000002",
          amount: "99",
        },
      ],
    };
    expect(() => store.importBackup(conflicting, preview)).toThrow(/排序/);
    expect(store.exportBackup().snapshots).toEqual(before.snapshots);
    expect(store.get(a.id)?.balance).toBe("5");
  },
);
it.each(["manual", "sync"] as const)(
  "a new %s record supersedes a future-dated snapshot and survives backup",
  (source) => {
    const a = store.create(input);
    store.record(a.id, "9", "sync", "USD", "");
    const future = store.exportBackup();
    future.snapshots = future.snapshots.map((s) => ({
      ...s,
      at: "2099-01-01T00:00:00.000Z",
    }));
    store.importBackup(future, false);
    store.record(a.id, "1", source, "USD", "correct current balance");
    expect(store.get(a.id)).toMatchObject({
      balance: "1",
      balanceSource: source,
    });
    const legacy = store.exportBackup();
    const accounts = legacy.accounts.map(({ balanceSnapshotId, ...old }) => {
      void balanceSnapshotId;
      return old;
    });
    store.importBackup(
      { ...legacy, version: 2, accounts, snapshots: [] },
      false,
    );
    expect(store.get(a.id)).toMatchObject({
      balance: "1",
      balanceSource: source,
    });
    const restored = new Store(join(dir, "clock-recovery.sqlite"), key);
    try {
      restored.importBackup(store.exportBackup(), false);
      expect(restored.get(a.id)).toMatchObject({
        balance: "1",
        balanceSource: source,
      });
    } finally {
      restored.close();
    }
  },
);
it.each([true, false])(
  "rejects cross-account current snapshot references without mutation (preview=%s)",
  (preview) => {
    const a = store.create({ ...input, initialBalance: "5" });
    const b = store.create({ ...input, name: "another", initialBalance: "8" });
    const before = store.exportBackup();
    const bad = {
      ...before,
      accounts: before.accounts.map((row) =>
        row.id === a.id
          ? { ...row, balanceSnapshotId: store.history(b.id)[0].id }
          : row,
      ),
    };
    expect(() => store.importBackup(bad, preview)).toThrow(/余额引用/);
    expect(store.exportBackup().accounts).toEqual(before.accounts);
    expect(store.exportBackup().snapshots).toEqual(before.snapshots);
  },
);
it.each([true, false])(
  "rejects ambiguous new legacy ties while preserving known local records (preview=%s)",
  (preview) => {
    const a = store.create({ ...input, initialBalance: "5" });
    const before = store.exportBackup();
    const { recordOrder, ...old } = before.snapshots[0];
    void recordOrder;
    const bad = {
      ...before,
      version: 2,
      snapshots: [
        { ...old, id: "00000000-0000-4000-8000-000000000099", amount: "99" },
      ],
    };
    expect(() => store.importBackup(bad, preview)).toThrow(/排序/);
    expect(store.exportBackup().accounts).toEqual(before.accounts);
    expect(store.exportBackup().snapshots).toEqual(before.snapshots);
    expect(store.get(a.id)?.balance).toBe("5");
  },
);
it.each([true, false])(
  "rejects reversed known anchors in a legacy merge without mutation (preview=%s)",
  (preview) => {
    const a = store.create(input);
    store.record(a.id, "1", "manual", "USD", "");
    store.record(a.id, "3", "sync", "USD", "");
    const seed = store.exportBackup();
    seed.snapshots = seed.snapshots.map((s) => ({
      ...s,
      at: "2026-10-03T00:00:00.000Z",
      recordOrder: s.amount === "1" ? 1 : 3,
    }));
    store.importBackup(seed, false);
    const before = store.exportBackup();
    const old = before.snapshots.map(({ recordOrder, ...s }) => {
      void recordOrder;
      return s;
    });
    const accounts = before.accounts.map(({ balanceSnapshotId, ...row }) => {
      void balanceSnapshotId;
      return row;
    });
    const first = old.find((s) => s.amount === "1")!;
    const last = old.find((s) => s.amount === "3")!;
    const bad = {
      ...before,
      version: 2,
      accounts,
      snapshots: [
        { ...first, id: "00000000-0000-4000-8000-000000000098", amount: "99" },
        first,
        last,
      ],
    };
    expect(() => store.importBackup(bad, preview)).toThrow(/排序/);
    expect(store.exportBackup().accounts).toEqual(before.accounts);
    expect(store.exportBackup().snapshots).toEqual(before.snapshots);
  },
);
it("sorts valid ISO instants, not their string spelling", () => {
  const a = store.create(input);
  store.record(a.id, "1", "manual", "USD", "older");
  store.record(a.id, "2", "sync", "USD", "later");
  const backup = store.exportBackup();
  backup.snapshots = backup.snapshots.map((s) => ({
    ...s,
    at: s.amount === "1" ? "2026-10-03T00:00:00Z" : "2026-10-03T00:00:00.500Z",
  }));
  const other = new Store(join(dir, "iso.sqlite"), key);
  try {
    other.importBackup(backup, false);
    expect(other.get(a.id)).toMatchObject({
      balance: "2",
      balanceSource: "sync",
    });
    expect(other.history()[0].amount).toBe("2");
  } finally {
    other.close();
  }
});
it("does not publish old raw sync errors or trust an unrelated old diagnostic", async () => {
  const a = store.create(input),
    db = new Database(path);
  try {
    const row = JSON.parse(
      (
        db.prepare("SELECT payload FROM accounts WHERE id=?").get(a.id) as {
          payload: string;
        }
      ).payload,
    );
    Object.assign(row, {
      lastSyncStatus: "error",
      lastSyncAt: "2026-10-03T00:00:04.000Z",
      lastSyncError: "https://private.invalid/?token=PRIVATE_SECRET",
      lastQueryDiagnostic: {
        ...diagnostic("sync", true),
        finishedAt: "2026-10-03T00:00:00.000Z",
      },
    });
    db.prepare("UPDATE accounts SET payload=? WHERE id=?").run(
      JSON.stringify(row),
      a.id,
    );
    const serialized = JSON.stringify(store.list());
    expect(serialized).not.toContain("PRIVATE_SECRET");
    expect(serialized).not.toContain("private.invalid");
    expect(store.get(a.id)!.lastSyncError).toContain("查询失败");
    const raw = "c".repeat(64);
    store.createSession(tokenHash(raw), "d".repeat(48));
    const response = await handleApi(
      new Request("http://localhost/api/accounts", {
        headers: { cookie: "atlas_session=" + raw },
      }),
      ["accounts"],
      store,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("PRIVATE_SECRET");
    expect(body).not.toContain("private.invalid");
  } finally {
    db.close();
  }
});
it("migrates a real pre-stage3 schema using numeric instants without rewriting payloads", () => {
  const a = store.create(input);
  store.record(a.id, "1", "manual", "USD", "");
  store.record(a.id, "2", "sync", "USD", "");
  const legacyPath = join(dir, "legacy.sqlite"),
    db = new Database(legacyPath);
  const snapshots = store.history(a.id).map((s) => ({
    ...s,
    at: s.amount === "1" ? "2026-10-03T00:00:00Z" : "2026-10-03T00:00:00.500Z",
  }));
  db.exec(
    "CREATE TABLE accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,secret TEXT); CREATE TABLE snapshots(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO accounts(id,payload) VALUES(?,?)").run(
    a.id,
    JSON.stringify(store.get(a.id)),
  );
  for (const s of snapshots) {
    const { recordOrder, ...old } = s;
    void recordOrder;
    db.prepare("INSERT INTO snapshots VALUES(?,?,?,?)").run(
      old.id,
      old.accountId,
      JSON.stringify(old),
      old.at,
    );
  }
  const before = db
    .prepare("SELECT id,payload,at FROM snapshots ORDER BY id")
    .all();
  db.close();
  const legacy = new Store(legacyPath, key);
  try {
    expect(legacy.get(a.id)).toMatchObject({
      balance: "2",
      balanceSource: "sync",
    });
    expect(legacy.history()[0].amount).toBe("2");
    const inspect = new Database(legacyPath);
    try {
      expect(
        inspect
          .prepare("SELECT id,payload,at FROM snapshots ORDER BY id")
          .all(),
      ).toEqual(before);
    } finally {
      inspect.close();
    }
  } finally {
    legacy.close();
  }
});
it.each([1, 2])(
  "reads legacy version %s backups without ordering extensions",
  (version) => {
    const a = store.create(input);
    store.record(a.id, "4", "sync", "USD", "");
    const backup = { ...store.exportBackup(), version };
    const accounts = backup.accounts.map((a) => {
      const { balanceSnapshotId, ...old } = a;
      void balanceSnapshotId;
      return old;
    });
    const snapshots = backup.snapshots.map((s) => {
      const { recordOrder, ...old } = s;
      void recordOrder;
      return old;
    });
    const restored = new Store(join(dir, "legacy-backup.sqlite"), key);
    try {
      restored.importBackup({ ...backup, accounts, snapshots }, false);
      expect(restored.get(a.id)).toMatchObject({
        balance: "4",
        balanceSource: "sync",
      });
    } finally {
      restored.close();
    }
  },
);
it("rolls back a snapshot and successful diagnosis together on DB write failure", () => {
  const a = store.create(input),
    db = new Database(path);
  try {
    db.exec(
      "CREATE TRIGGER fixture_reject BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    expect(() =>
      store.record(a.id, "9", "sync", "USD", "", null, diagnostic("sync")),
    ).toThrow();
    expect(store.history(a.id)).toHaveLength(0);
    expect(store.get(a.id)).toMatchObject({
      balance: null,
      lastSyncStatus: "never",
      lastSyncDiagnostic: null,
    });
  } finally {
    db.close();
  }
});
it("keeps the latest provenance for millisecond ties in history and a round-trip backup", () => {
  const a = store.create(input);
  store.record(a.id, "1", "manual", "USD", "first");
  store.record(a.id, "2", "sync", "USD", "second");
  const db = new Database(path);
  try {
    const at = "2026-10-03T00:00:00.000Z";
    db.prepare(
      "UPDATE snapshots SET at=?, at_ms=?, payload=json_set(payload,'$.at',?) WHERE account_id=?",
    ).run(at, Date.parse(at), at, a.id);
    const backup = store.exportBackup();
    expect(backup.snapshots[0].source).toBe("sync");
    expect(store.history(a.id)[0].source).toBe("sync");
    const other = new Store(join(dir, "tied.sqlite"), key);
    try {
      other.importBackup(backup, false);
      expect(other.get(a.id)).toMatchObject({
        balance: "2",
        balanceSource: "sync",
        lastSnapshotAt: at,
      });
      expect(other.history(a.id)[0].source).toBe("sync");
    } finally {
      other.close();
    }
  } finally {
    db.close();
  }
});
