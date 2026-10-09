import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { hashPassword } from "../src/lib/crypto";
import { handleApi } from "../src/lib/api";
let dir: string, store: Store;
const input = {
  name: "同站账号",
  siteUrl: "https://relay.example",
  provider: "manual",
  unit: "USD",
};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-test-"));
  store = new Store(join(dir, "test.sqlite"), Buffer.alloc(32, 7));
  store.setMeta("adminHash", hashPassword("test-password-123"));
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("persistent account and snapshot lifecycle", () => {
  it("allows same-domain accounts and persists zero snapshots", () => {
    let a = store.create(input),
      b = store.create(input);
    expect(a.id).not.toBe(b.id);
    store.record(a.id, "0", "manual", "USD", "修正");
    expect(store.get(a.id)?.balance).toBe("0");
    expect(store.history(a.id)).toHaveLength(1);
  });
  it("preserves balance and snapshots when a sync fails", () => {
    let a = store.create(input);
    store.record(a.id, "15.25", "sync", "USD", "");
    store.syncFailure(a.id, "查询失败");
    expect(store.get(a.id)?.balance).toBe("15.25");
    expect(store.get(a.id)?.lastSyncStatus).toBe("error");
    expect(store.history(a.id)).toHaveLength(1);
  });
  it("encrypts credentials and excludes them from API and exports", () => {
    let a = store.create({
      ...input,
      provider: "newapi",
      credential: "fixture-secret",
    });
    expect(store.get(a.id)?.hasCredential).toBe(true);
    expect(JSON.stringify(store.get(a.id))).not.toContain("fixture-secret");
    expect(JSON.stringify(store.exportBackup())).not.toContain(
      "fixture-secret",
    );
    expect(store.credential(a.id)).toBe("fixture-secret");
  });
  it("previews import and atomically restores metadata and histories", () => {
    let backup = store.exportBackup();
    expect(store.importBackup(backup, true).accounts).toBe(
      backup.accounts.length,
    );
    let count = store.list().length;
    store.importBackup(backup, false);
    expect(store.list()).toHaveLength(count);
    expect(() =>
      store.importBackup({ ...backup, version: 999 }, false),
    ).toThrow();
    expect(store.list()).toHaveLength(count);
  });
  it.each([true, false])(
    "rejects snapshot ownership conflicts without mutations (preview=%s)",
    (preview) => {
      const a = store.create({ ...input, name: "original owner" });
      const b = store.create({ ...input, name: "other owner" });
      store.record(a.id, "10", "manual", "USD", "");
      store.record(b.id, "20", "manual", "USD", "");
      const backup = store.exportBackup();
      const beforeAccounts = store.list();
      const beforeHistory = store.history();
      const beforeSettings = store.settings();
      const conflicting = {
        ...backup,
        accounts: backup.accounts.filter((x) => x.id === b.id),
        snapshots: [{ ...store.history(a.id)[0], accountId: b.id }],
        settings: { theme: "dark" as const, motion: false },
      };
      expect(() => store.importBackup(conflicting, preview)).toThrow();
      expect(store.list()).toEqual(beforeAccounts);
      expect(store.history()).toEqual(beforeHistory);
      expect(store.settings()).toEqual(beforeSettings);
      expect(store.get(a.id)?.balance).toBe("10");
      expect(store.get(b.id)?.balance).toBe("20");
    },
  );
  it.each([true, false])(
    "reports backup ownership conflicts as actionable 400s (preview=%s)",
    async (preview) => {
      const a = store.create(input),
        b = store.create(input);
      store.record(a.id, "7", "manual", "USD", "");
      const backup = store.exportBackup();
      const raw = (preview ? "e" : "f").repeat(64),
        csrf = "a".repeat(48);
      store.createSession(
        (await import("../src/lib/crypto")).tokenHash(raw),
        csrf,
      );
      const response = await handleApi(
        new Request("http://localhost/api/backup/import", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            cookie: "atlas_session=" + raw,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            preview,
            backup: {
              ...backup,
              accounts: backup.accounts.filter((x) => x.id === b.id),
              snapshots: [{ ...store.history(a.id)[0], accountId: b.id }],
            },
          }),
        }),
        ["backup", "import"],
        store,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("归属冲突");
      expect(store.get(a.id)?.balance).toBe("7");
      expect(store.get(b.id)?.balance).toBeNull();
    },
  );
  it("deleting an account removes its snapshots", () => {
    let a = store.create(input);
    store.record(a.id, "1", "manual", "USD", "");
    store.remove(a.id);
    expect(store.history(a.id)).toEqual([]);
    expect(store.get(a.id)).toBeUndefined();
  });
});
describe("authenticated routes and CSRF", () => {
  it("rejects malformed same-length unicode CSRF with 403", async () => {
    let raw = "a".repeat(64);
    store.createSession(
      (await import("../src/lib/crypto")).tokenHash(raw),
      "b".repeat(48),
    );
    let r = await handleApi(
      new Request("http://localhost/api/accounts", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie: "atlas_session=" + raw,
          "x-csrf-token": "é".repeat(48),
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      ["accounts"],
      store,
    );
    expect(r.status).toBe(403);
  });
  it("persists data and encrypted tokens across a reopen", () => {
    let path = join(dir, "restart.sqlite"),
      key = Buffer.alloc(32, 9),
      first = new Store(path, key),
      a = first.create({ ...input, credential: "persist-token" });
    first.record(a.id, "12.34", "manual", "USD", "");
    first.close();
    let next = new Store(path, key);
    expect(next.get(a.id)?.balance).toBe("12.34");
    expect(next.credential(a.id)).toBe("persist-token");
    next.close();
  });
  it("blocks anonymous reads and wrong-origin writes", async () => {
    let r = await handleApi(
      new Request("http://localhost/api/accounts"),
      ["accounts"],
      store,
    );
    expect(r.status).toBe(401);
    r = await handleApi(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "test-password-123" }),
      }),
      ["auth", "login"],
      store,
    );
    expect(r.status).toBe(403);
  });
  it("accepts loopback Host when Next canonicalizes the request URL to localhost", async () => {
    const response = await handleApi(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          host: "127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "test-password-123" }),
      }),
      ["auth", "login"],
      store,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
  it("does not trust arbitrary Host headers for an unconfigured public deployment", async () => {
    const response = await handleApi(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          origin: "http://evil.example",
          host: "evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "test-password-123" }),
      }),
      ["auth", "login"],
      store,
    );
    expect(response.status).toBe(403);
  });
  it("keeps the configured HTTPS public origin authoritative over loopback Host", async () => {
    const previous = process.env.RELAYDOCK_PUBLIC_URL;
    process.env.RELAYDOCK_PUBLIC_URL = "https://atlas.example";
    try {
      const request = (origin: string) =>
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: {
            origin,
            host: "127.0.0.1:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "test-password-123" }),
        });
      const accepted = await handleApi(
        request("https://atlas.example"),
        ["auth", "login"],
        store,
      );
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("set-cookie")).toContain("Secure");
      const rejected = await handleApi(
        request("http://127.0.0.1:3000"),
        ["auth", "login"],
        store,
      );
      expect(rejected.status).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.RELAYDOCK_PUBLIC_URL;
      else process.env.RELAYDOCK_PUBLIC_URL = previous;
    }
  });
  it("requires CSRF, logs in and logs out", async () => {
    let login = await handleApi(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "test-password-123" }),
      }),
      ["auth", "login"],
      store,
    );
    expect(login.status).toBe(200);
    let data = await login.json(),
      cookie = login.headers.get("set-cookie")!.split(";")[0];
    let r = await handleApi(
      new Request("http://localhost/api/accounts", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      ["accounts"],
      store,
    );
    expect(r.status).toBe(403);
    r = await handleApi(
      new Request("http://localhost/api/accounts", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie,
          "content-type": "application/json",
          "x-csrf-token": data.csrf,
        },
        body: JSON.stringify(input),
      }),
      ["accounts"],
      store,
    );
    expect(r.status).toBe(201);
    r = await handleApi(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie,
          "x-csrf-token": data.csrf,
        },
      }),
      ["auth", "logout"],
      store,
    );
    expect(r.status).toBe(200);
    expect(
      (
        await handleApi(
          new Request("http://localhost/api/accounts", { headers: { cookie } }),
          ["accounts"],
          store,
        )
      ).status,
    ).toBe(401);
  });
  it("does not leak password or request body on errors", async () => {
    let r = await handleApi(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "private-wrong-pass" }),
      }),
      ["auth", "login"],
      store,
    );
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("private-wrong-pass");
  });
});
