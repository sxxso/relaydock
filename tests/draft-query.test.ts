import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { diagnosticReport } from "../src/lib/query-diagnostics";

const store = new Store(":memory:", Buffer.alloc(32, 7));
const raw = "c".repeat(64),
  csrf = "d".repeat(48),
  secret = "fixture-only-credential";
const previous = {
  private: process.env.RELAYDOCK_PRIVATE_HOSTS,
  dns: process.env.RELAYDOCK_DNS_MODE,
};
let root = "",
  hits = 0,
  held: ServerResponse | null = null;
const server = createServer((req, res) => {
  hits++;
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/hold") {
    held = res;
    return;
  }
  if (req.url === "/api/user/self")
    res.end(
      JSON.stringify({
        success: true,
        data: { quota: "123456789012345678901234" },
      }),
    );
  else if (req.url === "/api/usage/token")
    res.end(
      JSON.stringify({
        code: true,
        data: { unlimited_quota: false, total_available: "1000000" },
      }),
    );
  else if (req.url === "/401") {
    res.statusCode = 401;
    res.end(secret);
  } else if (req.url === "/redirect") {
    res.writeHead(302, { Location: root + "/zero" });
    res.end(secret);
  } else if (req.url === "/bad") res.end(JSON.stringify({ balance: secret }));
  else res.end(JSON.stringify({ balance: "0", ignored_secret: secret }));
});
beforeAll(async () => {
  store.createSession(tokenHash(raw), csrf);
  store.create({
    name: "existing-fixture",
    siteUrl: "https://saved.example",
    initialBalance: "8.5",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  root = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
  process.env.RELAYDOCK_DNS_MODE = "system";
});
afterAll(async () => {
  held?.end();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  for (const [key, value] of [
    ["RELAYDOCK_PRIVATE_HOSTS", previous.private],
    ["RELAYDOCK_DNS_MODE", previous.dns],
  ])
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
});
const input = (overrides = {}) => ({
  provider: "custom",
  siteUrl: root,
  managementUrl: root,
  credential: secret,
  query: { path: "/zero" },
  ...overrides,
});
function call(data: unknown, headers = {}, method = "POST") {
  return handleApi(
    new Request("http://localhost/api/query/test", {
      method,
      headers: {
        origin: "http://localhost",
        cookie: "atlas_session=" + raw,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...headers,
      },
      ...(method === "POST" ? { body: JSON.stringify(data) } : {}),
    }),
    ["query", "test"],
    store,
  );
}
function persisted() {
  return JSON.stringify({
    accounts: store.list(),
    history: store.history(),
    settings: store.settings(),
  });
}
it("tests a draft without creating accounts, snapshots, diagnostics or encrypted credentials", async () => {
  const before = persisted(),
    count = hits;
  const response = await call(input()),
    body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    balance: "0",
    unit: "USD",
    rawQuota: null,
    diagnostic: { operation: "test", code: "ok" },
  });
  expect(body.diagnostic.stages[0]).toMatchObject({
    status: "skipped",
    durationMs: 0,
  });
  expect(hits - count).toBe(1);
  expect(persisted()).toBe(before);
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(JSON.stringify(body)).not.toContain(root);
  expect(diagnosticReport(body.diagnostic)).not.toContain("saved.example");
});
it("tests the account management and single-token scopes without guessing from their common domain", async () => {
  const before = persisted();
  const a = await (
    await call(input({ provider: "newapi", query: {}, userId: "123" }))
  ).json();
  const t = await (
    await call(input({ provider: "newapi-token", query: {} }))
  ).json();
  expect(a).toMatchObject({
    balance: "123456789012345678901234",
    unit: "配额",
    rawQuota: "123456789012345678901234",
  });
  expect(t).toMatchObject({
    balance: "1000000",
    unit: "令牌配额",
    rawQuota: "1000000",
  });
  expect(a.diagnostic.provider).toBe("newapi");
  expect(t.diagnostic.provider).toBe("newapi-token");
  expect(persisted()).toBe(before);
});
it("can parse explicitly configured conversion with precise strings without recording it", async () => {
  const response = await call(
    input({
      provider: "newapi-token",
      quotaPerUnit: "500000",
      unit: "CNY",
      query: {},
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    balance: "2",
    unit: "令牌额度 (CNY)",
    rawQuota: "1000000",
  });
});
it.each([
  ["/401", "http_auth"],
  ["/bad", "invalid_balance"],
  ["/redirect", "http_redirect"],
])(
  "returns bounded %s diagnostics without mutations or retries",
  async (path, code) => {
    const before = persisted(),
      count = hits;
    const response = await call(input({ query: { path } })),
      body = await response.json();
    expect(response.status).toBe(502);
    expect(body.diagnostic.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(hits - count).toBe(1);
    expect(persisted()).toBe(before);
  },
);
it.each([
  [{ cookie: "" }, 401],
  [{ "x-csrf-token": "" }, 403],
  [{ origin: "https://evil.example" }, 403],
])(
  "denies unauthorized draft tests before any provider query",
  async (headers, status) => {
    const count = hits;
    expect((await call(input(), headers)).status).toBe(status);
    expect(hits).toBe(count);
  },
);
it.each([
  { provider: "manual" },
  { credential: "中文密钥" },
  { credential: "" },
  { managementUrl: "https://example.com?token=fixture-private" },
  { query: { path: "https://evil.example" } },
  { name: "must-not-be-accepted" },
  { initialBalance: "12" },
  { provider: "newapi-token", unit: "积分" },
])(
  "rejects invalid or unrelated fields before network work",
  async (override) => {
    const count = hits;
    expect((await call(input(override))).status).toBe(400);
    expect(hits).toBe(count);
  },
);
it("keeps metadata and unallowlisted private targets denied for drafts", async () => {
  const before = persisted(),
    count = hits;
  for (const target of ["http://169.254.169.254", "http://192.168.4.2"]) {
    const r = await call(input({ siteUrl: target, managementUrl: target })),
      b = await r.json();
    expect(r.status).toBe(502);
    expect(b.diagnostic.code).toBe("unsafe_target");
  }
  expect(hits).toBe(count);
  expect(persisted()).toBe(before);
});
it("holds at most one draft query per session, releases the guard and never persists the result", async () => {
  const before = persisted(),
    count = hits;
  const first = call(input({ query: { path: "/hold" } }));
  try {
    for (let i = 0; !held && i < 100; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(held).not.toBeNull();
    expect((await call(input())).status).toBe(409);
    expect(hits - count).toBe(1);
  } finally {
    held?.end(JSON.stringify({ balance: "1.25" }));
  }
  expect((await first).status).toBe(200);
  held = null;
  expect((await call(input())).status).toBe(200);
  expect(persisted()).toBe(before);
});
it("does not expose GET draft tests or convert saving into an external query", async () => {
  const count = hits;
  expect((await call(null, {}, "GET")).status).toBe(404);
  const r = await handleApi(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        cookie: "atlas_session=" + raw,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        name: "unverified-fixture",
        siteUrl: root,
        provider: "newapi",
        credential: secret,
      }),
    }),
    ["accounts"],
    store,
  );
  expect(r.status).toBe(201);
  const a = await r.json();
  expect(a.balance).toBeNull();
  expect(a.lastQueryDiagnostic).toBeNull();
  expect(a.hasCredential).toBe(true);
  expect(store.history(a.id)).toEqual([]);
  expect(hits).toBe(count);
});
