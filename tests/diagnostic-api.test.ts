import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { diagnosticReport } from "../src/lib/query-diagnostics";

let server: Server,
  store: Store,
  root: string,
  dir: string,
  hits = 0;
const csrf = "a".repeat(48),
  raw = "b".repeat(64),
  secret = "fixture-private-secret";
const env = {
  private: process.env.RELAYDOCK_PRIVATE_HOSTS,
  dns: process.env.RELAYDOCK_DNS_MODE,
};
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-diagnostic-"));
  store = new Store(join(dir, "test.sqlite"), Buffer.alloc(32, 9));
  store.createSession(tokenHash(raw), csrf);
  server = createServer((req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/success") res.end(JSON.stringify({ balance: "0" }));
    else if (req.url === "/delayed") {
      setTimeout(() => {
        res.writeHead(200);
        res.flushHeaders();
        res.end(JSON.stringify({ balance: "2.5" }));
      }, 60);
    } else if (req.url === "/invalid-json")
      res.end("<html>" + secret + "</html>");
    else if (req.url === "/malformed-json") res.end('{"balance":' + secret);
    else if (req.url === "/empty") res.end();
    else if (req.url === "/invalid-balance")
      res.end(JSON.stringify({ balance: secret }));
    else if (req.url === "/rejected")
      res.end(
        JSON.stringify({ success: false, message: secret, token: secret }),
      );
    else if (req.url === "/read-stall") {
      res.writeHead(200);
      res.flushHeaders();
      res.write('{"balance":');
    } else if (req.url === "/response-stall") return;
    else if (req.url === "/broken") {
      res.writeHead(200);
      res.flushHeaders();
      res.write('{"balance":');
      setTimeout(() => res.destroy(), 10);
    } else {
      const status = Number(req.url?.slice(1)) || 404;
      res.writeHead(
        status,
        status === 302 ? { Location: root + "/success" } : {},
      );
      res.end(secret);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  root = "http://localhost:" + (server.address() as { port: number }).port;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "localhost,127.0.0.1";
  process.env.RELAYDOCK_DNS_MODE = "system";
});
afterAll(async () => {
  store.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["RELAYDOCK_PRIVATE_HOSTS", env.private],
    ["RELAYDOCK_DNS_MODE", env.dns],
  ])
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
});
const create = (path: string, overrides = {}) =>
  store.create({
    name: "private-account-name",
    siteUrl: root,
    provider: "custom",
    credential: secret,
    initialBalance: "8.5",
    userId: "987654",
    query: { path },
    ...overrides,
  });
const call = (id: string, action = "sync", headers = {}) =>
  handleApi(
    new Request("http://localhost/api/accounts/" + id + "/" + action, {
      method: "POST",
      headers: {
        origin: "http://localhost",
        cookie: "atlas_session=" + raw,
        "x-csrf-token": csrf,
        ...headers,
      },
    }),
    ["accounts", id, action],
    store,
  );

it("measures DNS, connection and actual response wait; persists successful sync diagnostics", async () => {
  const a = create("/delayed");
  const before = hits;
  const r = await call(a.id);
  const body = await r.json();
  expect(r.status).toBe(200);
  expect(body.balance).toBe("2.5");
  expect(body.balanceSource).toBe("sync");
  const d = body.lastQueryDiagnostic;
  expect(d).toMatchObject({
    code: "ok",
    operation: "sync",
    httpStatus: 200,
    dnsMode: "system",
  });
  expect(
    d.stages.every((s: any) => s.status === "success" && s.durationMs >= 0),
  ).toBe(true);
  expect(
    d.stages.find((s: any) => s.id === "response").durationMs,
  ).toBeGreaterThanOrEqual(45);
  expect(d.totalMs).toBeGreaterThanOrEqual(45);
  expect(store.get(a.id)?.lastQueryDiagnostic).toEqual(d);
  expect(store.get(a.id)?.lastSyncDiagnostic).toEqual(d);
  expect(hits - before).toBe(1);
  store.close();
  store = new Store(join(dir, "test.sqlite"), Buffer.alloc(32, 9));
  expect(store.get(a.id)?.lastQueryDiagnostic).toEqual(d);
  expect(JSON.stringify(store.exportBackup())).not.toContain(
    "lastQueryDiagnostic",
  );
});
it("tests without snapshots, without changing last successful sync or the balance", async () => {
  const a = create("/success", {
    siteUrl: root.replace("localhost", "127.0.0.1"),
  });
  const count = store.history(a.id).length;
  const r = await call(a.id, "test");
  const body = await r.json();
  expect(body.diagnostic).toMatchObject({ code: "ok", operation: "test" });
  expect(body.diagnostic.stages[0]).toMatchObject({
    status: "skipped",
    durationMs: 0,
  });
  expect(store.get(a.id)?.balance).toBe("8.5");
  expect(store.get(a.id)?.balanceSource).toBe("manual");
  expect(store.get(a.id)?.lastSyncDiagnostic).toBeNull();
  expect(store.get(a.id)?.lastSyncStatus).toBe("never");
  expect(store.history(a.id)).toHaveLength(count);
  expect(store.get(a.id)?.lastQueryDiagnostic).toEqual(body.diagnostic);
});
it.each([
  ["/401", "http_auth", "auth", 401],
  ["/403", "http_auth", "auth", 403],
  ["/404", "http_missing", "compatibility", 404],
  ["/429", "http_limited", "rate-limit", 429],
  ["/302", "http_redirect", "compatibility", 302],
  ["/500", "http_error", "service", 500],
  ["/invalid-json", "response_html", "compatibility", 200],
  ["/malformed-json", "invalid_json", "compatibility", 200],
  ["/empty", "response_empty", "service", 200],
  ["/invalid-balance", "invalid_balance", "compatibility", 200],
  ["/rejected", "provider_rejected", "service", 200],
  ["/broken", "read_failed", "network", 200],
])(
  "classifies %s and does not retry, erase balance or disclose upstream echoes",
  async (path, code, category, httpStatus) => {
    // "8.5" can legitimately occur in an ISO timestamp (38.504Z) or timing.
    // Keep scanning the entire report, using a precise balance that cannot
    // collide with millisecond timestamps or one-decimal duration fields.
    const balanceSentinel = "8.500123456789";
    const a = create(String(path), { initialBalance: balanceSentinel });
    const before = hits;
    const r = await call(a.id);
    const body = await r.json();
    expect(r.status).toBe(502);
    expect(body.diagnostic).toMatchObject({
      code,
      category,
      httpStatus,
      outcome: "failure",
    });
    expect(store.get(a.id)?.balance).toBe(balanceSentinel);
    expect(store.get(a.id)?.balanceSource).toBe("manual");
    expect(store.get(a.id)?.lastSyncDiagnostic).toEqual(body.diagnostic);
    expect(store.history(a.id)).toHaveLength(1);
    expect(store.get(a.id)?.lastQueryDiagnostic).toEqual(body.diagnostic);
    expect(JSON.stringify(body)).not.toContain(secret);
    const report = diagnosticReport(body.diagnostic);
    for (const sensitive of [
      secret,
      a.name,
      a.id,
      "localhost",
      "127.0.0.1",
      "987654",
      '"balance":',
      balanceSentinel,
      String(path),
    ])
      expect(report).not.toContain(sensitive);
    expect(hits - before).toBe(1);
  },
);
it.each([
  ["/response-stall", "response_timeout", "response"],
  ["/read-stall", "read_timeout", "read"],
])(
  "records real timeout at %s and leaves later stages unexecuted",
  async (path, code, stage) => {
    const a = create(path);
    const before = hits;
    const r = await call(a.id);
    const body = await r.json();
    expect(body.diagnostic.code).toBe(code);
    expect(body.diagnostic.totalMs).toBeGreaterThanOrEqual(9900);
    expect(body.diagnostic.stages.find((s: any) => s.id === stage).status).toBe(
      "error",
    );
    expect(body.diagnostic.stages.at(-1)).toMatchObject({
      status: "not-run",
      durationMs: null,
    });
    expect(store.get(a.id)?.balance).toBe("8.5");
    expect(hits - before).toBe(1);
  },
  15000,
);
it("a failed connection test persists diagnosis, not sync status or balance history", async () => {
  const a = create("/401");
  const r = await call(a.id, "test");
  const body = await r.json();
  expect(body.diagnostic.operation).toBe("test");
  expect(store.get(a.id)?.lastSyncStatus).toBe("never");
  expect(store.get(a.id)?.balance).toBe("8.5");
  expect(store.history(a.id)).toHaveLength(1);
});
it("blocks private targets without sending credentials or fabricating a connection", async () => {
  const a = create("/success");
  const before = hits;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "";
  try {
    const r = await call(a.id);
    const body = await r.json();
    expect(body.diagnostic).toMatchObject({
      code: "unsafe_target",
      category: "security",
    });
    expect(body.diagnostic.stages[1]).toMatchObject({
      status: "not-run",
      durationMs: null,
    });
    expect(hits).toBe(before);
  } finally {
    process.env.RELAYDOCK_PRIVATE_HOSTS = "localhost,127.0.0.1";
  }
});
it("rejects unauthenticated and CSRF requests before starting diagnostics", async () => {
  const a = create("/success");
  const before = hits;
  expect((await call(a.id, "sync", { cookie: "" })).status).toBe(401);
  expect((await call(a.id, "test", { "x-csrf-token": "" })).status).toBe(403);
  expect(hits).toBe(before);
  expect(store.get(a.id)?.lastQueryDiagnostic ?? null).toBeNull();
});
it("reports missing credentials as configuration without executing any network stage", async () => {
  const a = create("/success", { credential: "" });
  const before = hits;
  const r = await call(a.id, "test");
  const body = await r.json();
  expect(r.status).toBe(400);
  expect(body.diagnostic).toMatchObject({
    code: "missing_credential",
    category: "configuration",
  });
  expect(
    body.diagnostic.stages.every(
      (s: any) => s.status === "not-run" && s.durationMs === null,
    ),
  ).toBe(true);
  expect(hits).toBe(before);
});
it("does not persist half a failed attempt when status persistence fails", async () => {
  const a = create("/401");
  const failure = vi.spyOn(store, "syncFailure").mockImplementationOnce(() => {
    throw new Error("fixture persistence failure");
  });
  try {
    expect((await call(a.id)).status).toBe(500);
    expect(store.get(a.id)?.lastQueryDiagnostic ?? null).toBeNull();
    expect(store.get(a.id)?.lastSyncStatus).toBe("never");
    expect(store.history(a.id)).toHaveLength(1);
  } finally {
    failure.mockRestore();
  }
});
it("does not claim a saved balance when database persistence fails after a successful query", async () => {
  const a = create("/success");
  const record = vi.spyOn(store, "record").mockImplementationOnce(() => {
    throw new Error("simulated storage failure");
  });
  try {
    const r = await call(a.id);
    const body = await r.json();
    expect(r.status).toBe(500);
    expect(body.diagnostic).toBeUndefined();
    expect(store.get(a.id)?.balance).toBe("8.5");
    expect(store.get(a.id)?.lastQueryDiagnostic ?? null).toBeNull();
  } finally {
    record.mockRestore();
  }
});
