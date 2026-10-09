import { beforeAll, afterAll, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { totals } from "../src/lib/money";
import Database from "better-sqlite3";
let server: Server,
  store: Store,
  root: string,
  dir: string,
  hits = 0;
const requests: {
  url: string;
  method: string;
  authorization?: string;
  userId?: string;
  key?: string;
}[] = [];
const old = process.env.RELAYDOCK_PRIVATE_HOSTS,
  csrf = "a".repeat(48),
  raw = "b".repeat(64);
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-platform-"));
  store = new Store(join(dir, "test.sqlite"), Buffer.alloc(32, 4));
  store.createSession(tokenHash(raw), csrf);
  server = createServer((req, res) => {
    hits++;
    requests.push({
      url: req.url || "",
      method: req.method || "",
      authorization: req.headers.authorization,
      userId: req.headers["new-api-user"] as string | undefined,
      key: req.headers["x-api-key"] as string | undefined,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/overflow/"))
      res.end(
        JSON.stringify(
          req.url.endsWith("/api/usage/token")
            ? {
                code: true,
                data: {
                  total_available: "1000000000000",
                  unlimited_quota: false,
                },
              }
            : { success: true, data: { quota: "1000000000000" } },
        ),
      );
    else if (req.url?.startsWith("/rejected/"))
      res.end(
        JSON.stringify({
          success: false,
          message: req.headers.authorization || req.headers["x-api-key"],
        }),
      );
    else if (req.url?.startsWith("/invalid/"))
      res.end(JSON.stringify({ data: {}, balance: null }));
    else if (req.url === "/api/user/self")
      res.end(JSON.stringify({ success: true, data: { quota: "750000" } }));
    else if (req.url === "/user/balance")
      res.end(
        JSON.stringify({
          is_available: true,
          balance: "0",
          balance_infos: [{ currency: "CNY", total_balance: "1.25" }],
        }),
      );
    else if (req.url === "/api/v1/credits")
      res.end(
        JSON.stringify({ data: { total_credits: "5.3", total_usage: "0.1" } }),
      );
    else if (req.url === "/api/usage/token")
      res.end(
        JSON.stringify({
          code: true,
          data: { total_available: "250000", unlimited_quota: false },
        }),
      );
    else if (req.url === "/v1/user/info")
      res.end(JSON.stringify({ status: true, data: { totalBalance: "12.5" } }));
    else if (req.url === "/wallet")
      res.end(JSON.stringify({ data: { amount: "1200", used: "100" } }));
    else if (req.url === "/missing")
      res.end(
        JSON.stringify({ success: false, message: req.headers.authorization }),
      );
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  root = "http://127.0.0.1:" + (server.address() as any).port;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
});
afterAll(async () => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (old === undefined) delete process.env.RELAYDOCK_PRIVATE_HOSTS;
  else process.env.RELAYDOCK_PRIVATE_HOSTS = old;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const call = (id: string, action: string) =>
  handleApi(
    new Request("http://localhost/api/accounts/" + id + "/" + action, {
      method: "POST",
      headers: {
        origin: "http://localhost",
        cookie: "atlas_session=" + raw,
        "x-csrf-token": csrf,
      },
    }),
    ["accounts", id, action],
    store,
  );
it.each([
  "newapi",
  "newapi-token",
  "generic",
  "deepseek",
  "openrouter",
  "siliconflow",
  "custom",
])(
  "queries %s through protected click-only route and tests without recording",
  async (provider) => {
    const account = store.create({
      name: provider,
      siteUrl: root,
      managementUrl: root,
      provider,
      unit: provider === "deepseek" ? "CNY" : "USD",
      quotaPerUnit: "500000",
      credential: "fixture-private-secret",
      userId: "123",
      query: {
        timeoutSeconds: 20,
        path: "/wallet",
        balancePath: "data.amount",
        subtractPath: "data.used",
        divisor: "100",
        authHeader: provider === "custom" ? "x-api-key" : "Authorization",
      },
    });
    const count = hits;
    expect(store.get(account.id)?.balance).toBeNull();
    expect(hits).toBe(count);
    const test = await call(account.id, "test");
    expect(test.status).toBe(200);
    expect((await test.json()).durationMs).toBeGreaterThanOrEqual(0);
    expect(store.history(account.id)).toHaveLength(0);
    const sync = await call(account.id, "sync");
    expect(sync.status).toBe(200);
    const result = await sync.json();
    expect(result.balance).toBe(
      (
        {
          newapi: "1.5",
          "newapi-token": "0.5",
          generic: "0",
          deepseek: "1.25",
          openrouter: "5.2",
          siliconflow: "12.5",
          custom: "11",
        } as any
      )[provider],
    );
    expect(store.history(account.id)).toHaveLength(1);
    expect(hits - count).toBe(2);
    for (const request of requests.slice(-2)) {
      expect(request.method).toBe("GET");
      expect(request.userId).toBe(provider === "newapi" ? "123" : undefined);
      expect(request.authorization).toBe(
        provider === "custom" ? undefined : "Bearer fixture-private-secret",
      );
      expect(request.key).toBe(
        provider === "custom" ? "fixture-private-secret" : undefined,
      );
    }
    expect(JSON.stringify(store.exportBackup())).not.toContain(
      "fixture-private-secret",
    );
  },
);
it.each([
  "newapi",
  "newapi-token",
  "generic",
  "deepseek",
  "openrouter",
  "siliconflow",
  "custom",
])(
  "%s failures retain exact prior balance/source/time and never retry",
  async (provider) => {
    for (const failure of ["rejected", "invalid"] as const) {
      const a = store.create({
        name: "synthetic failure",
        siteUrl: root,
        managementUrl: root + "/" + failure,
        provider,
        credential: "fixture-private-secret",
        initialBalance: "8.500123456789",
        unit: "CNY",
      });
      const previous = store.get(a.id)!,
        snapshots = store.history(a.id),
        count = hits;
      const r = await call(a.id, "sync"),
        body = await r.json();
      expect(r.status).toBe(502);
      expect(body.diagnostic.code).toBe(
        failure === "rejected" ? "provider_rejected" : "invalid_balance",
      );
      expect(JSON.stringify(body)).not.toContain("fixture-private-secret");
      expect(JSON.stringify(body.diagnostic)).not.toContain("8.500123456789");
      expect(store.get(a.id)).toMatchObject({
        balance: previous.balance,
        balanceUnit: previous.balanceUnit,
        balanceSnapshotId: previous.balanceSnapshotId,
        lastSyncStatus: "error",
      });
      expect(store.history(a.id)).toEqual(snapshots);
      expect(hits - count).toBe(1);
    }
  },
);
it.each(["newapi", "newapi-token"])(
  "%s rejects converted overflow during test and sync without changing snapshots",
  async (provider) => {
    const a = store.create({
      name: "synthetic overflow",
      siteUrl: root,
      managementUrl: root + "/overflow",
      provider,
      credential: "fixture-private-secret",
      quotaPerUnit: "0.000000000001",
      initialBalance: "8.500123456789",
    });
    const previous = store.get(a.id)!,
      history = store.history(a.id),
      count = hits;
    for (const operation of ["test", "sync"]) {
      const response = await call(a.id, operation),
        body = await response.json();
      expect(response.status).toBe(502);
      expect(body.diagnostic.code).toBe("invalid_balance");
      expect(
        body.diagnostic.stages.find((s: any) => s.id === "parse").status,
      ).toBe("error");
      expect(store.get(a.id)).toMatchObject({
        balance: previous.balance,
        balanceUnit: previous.balanceUnit,
        balanceSnapshotId: previous.balanceSnapshotId,
      });
      expect(store.history(a.id)).toEqual(history);
      expect(JSON.stringify(body)).not.toContain("fixture-private-secret");
    }
    expect(hits - count).toBe(2);
  },
);
it("preserves balance and redacts even a malicious provider error echo", async () => {
  const a = store.create({
    name: "fail",
    siteUrl: root,
    provider: "custom",
    credential: "fixture-private-secret",
    initialBalance: "8.1",
    query: { path: "/missing" },
  });
  const r = await call(a.id, "sync");
  expect(r.status).toBe(502);
  expect(JSON.stringify(await r.json())).not.toContain(
    "fixture-private-secret",
  );
  expect(store.get(a.id)?.balance).toBe("8.1");
  expect(store.get(a.id)?.lastSyncStatus).toBe("error");
  expect(store.history(a.id)).toHaveLength(1);
});
it("backs up mappings and background without credentials, then restores", () => {
  store.setSettings({
    theme: "dark",
    motion: false,
    mapBackground: "contours",
  });
  const backup = store.exportBackup();
  expect(backup.version).toBe(3);
  const restored = new Store(join(dir, "restored.sqlite"), Buffer.alloc(32, 5));
  try {
    restored.importBackup(backup, false);
    expect(restored.settings().mapBackground).toBe("contours");
    expect(
      restored.list().find((a) => a.provider === "custom")?.query.divisor,
    ).toBe("100");
    expect(restored.list().every((a) => !a.hasCredential)).toBe(true);
  } finally {
    restored.close();
  }
});
it("never adds manually entered or old token-labeled balances to account currency totals", () => {
  const a = store.create({
    name: "token",
    siteUrl: root,
    provider: "newapi-token",
    unit: "USD",
    initialBalance: "8",
  });
  expect(store.get(a.id)?.balanceUnit).toBe("令牌额度 (USD)");
  expect(totals([store.get(a.id)!]).USD).toBeUndefined();
  store.record(a.id, "12", "manual", "USD", "manual token");
  expect(store.history(a.id)[0].unit).toBe("令牌额度 (USD)");
  expect(
    totals([{ ...store.get(a.id)!, balanceUnit: "USD" }]).USD,
  ).toBeUndefined();
});
it("sanitizes legacy query root parameters in APIs and exported metadata", () => {
  const a = store.create({ name: "legacy", siteUrl: root, provider: "newapi" });
  const db = new Database(join(dir, "test.sqlite"));
  try {
    db.prepare(
      "UPDATE accounts SET payload = json_set(payload,'$.managementUrl',?,'$.apiUrl',?,'$.siteUrl',?) WHERE id=?",
    ).run(
      root + "?token=fixture-url-secret",
      root + "/v1?key=fixture-url-secret",
      root + "?token=fixture-url-secret",
      a.id,
    );
  } finally {
    db.close();
  }
  expect(store.get(a.id)?.managementUrl).toBe(root + "/");
  expect(JSON.stringify(store.list())).not.toContain("fixture-url-secret");
  expect(JSON.stringify(store.exportBackup())).not.toContain(
    "fixture-url-secret",
  );
});
it.each([true, false])(
  "normalizes valid legacy v1 URL parameters before import (preview=%s)",
  (preview) => {
    const a = store.create({ name: "legacy backup", siteUrl: root });
    const backup = store.exportBackup(),
      saved = backup.accounts.find((row) => row.id === a.id)!;
    const legacy = {
      ...backup,
      version: 1 as const,
      accounts: [
        {
          ...saved,
          details: {
            ...saved.details,
            apiUrl: root + "/v1?view=account",
            managementUrl: root + "?token=fixture-url-secret",
          },
        },
      ],
      snapshots: [],
    };
    expect(() => store.importBackup(legacy, preview)).not.toThrow();
    expect(legacy.accounts[0].details.managementUrl).toContain(
      "fixture-url-secret",
    );
    expect(JSON.stringify(store.exportBackup())).not.toContain(
      "fixture-url-secret",
    );
    if (!preview) expect(store.get(a.id)?.apiUrl).toBe(root + "/v1");
  },
);
