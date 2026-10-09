import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { accountDetails } from "../src/lib/validation";

let server: Server, store: Store, root: string, dir: string, dbPath: string;
let mode = "perf";
let onDeferred: (() => void) | undefined, deferred: ServerResponse | undefined;
const calls: { path: string; method?: string; auth?: string; user?: string }[] = [];
const raw = "b".repeat(64), csrf = "a".repeat(48), secret = "fixture-private-secret";
const oldPrivate = process.env.RELAYDOCK_PRIVATE_HOSTS;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-model-insight-"));
  dbPath = join(dir, "fixture.sqlite");
  store = new Store(dbPath, Buffer.alloc(32, 7));
  store.createSession(tokenHash(raw), csrf);
  server = createServer((req, res) => {
    const url = new URL(req.url!, root);
    calls.push({ path: url.pathname + url.search, method: req.method, auth: req.headers.authorization, user: req.headers["new-api-user"] as string });
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/prefix/api/status") {
      const send = () => res.end(JSON.stringify({ success: true, data: { HeaderNavModules: { pricing: { enabled: true } } } }));
      if (mode === "deadline") { setTimeout(send, 1500); return; } return send();
    }
    if (url.pathname === "/prefix/api/pricing") return res.end(JSON.stringify({ success: true, data: [{ model_name: "gpt-a", owner_by: "OpenAI", enable_groups: ["default"] }] }));
    if (url.pathname === "/prefix/api/perf-metrics/summary" || url.pathname === "/prefix/api/perf-metrics") {
      if (mode === "slow") return;
      if (mode === "deferred") { deferred = res; onDeferred?.(); return; }
      if (mode === "missing") { res.statusCode = 404; return res.end(secret); }
      if (mode === "denied") { res.statusCode = 403; return res.end(secret); }
      if (mode === "auth" && !req.headers.authorization) { res.statusCode = 401; return res.end(secret); }
      if (mode === "bad") return res.end(JSON.stringify({ success: false, message: secret }));
      if (mode === "deadline") { const timer = setTimeout(() => res.end(JSON.stringify({ success: true, data: { models: [] } })), 9500); res.once("close", () => clearTimeout(timer)); return; }
      if (mode === "union") return res.end(JSON.stringify({ success: true, data: { models: Array.from({length: 500}, (_, i) => ({ model_name: "other-" + i, success_rate: 90 })) } }));
      return res.end(JSON.stringify({ success: true, data: url.pathname.endsWith("summary") ? { models: [{ model_name: "gpt-a", success_rate: 96, avg_latency_ms: 900, recent_success_series: [{ ts: Math.floor(Date.now()/1000) - 100, success_rate: 96 }] }] } : { model_name: "gpt-a", groups: [{ group: "default", success_rate: 96, series: [{ ts: Math.floor(Date.now()/1000) - 100, success_rate: 96 }] }] } }));
    }
    if (url.pathname === "/prefix/api/log/self") {
      const page = Number(url.searchParams.get("p"));
      if (mode === "partial" && page === 2) { res.statusCode = 500; return res.end(secret); }
      const size = ["cap", "partial", "repeat", "total0", "total50"].includes(mode) ? 100 : 2;
      const items = Array.from({ length: size }, (_, i) => ({ id: (page - 1) * 100 + i, model_name: "gpt-a", type: i % 2 ? 5 : 2, created_at: Math.floor(Date.now()/1000) - 30, use_time: 2, completion_tokens: 80, other: '{"frt":200,"prompt":"fixture-private-prompt"}', token_name: secret, content: secret }));
      if (mode === "array") return res.end(JSON.stringify({ success: true, data: items }));
      if (mode === "badpage") return res.end(JSON.stringify({ success: true, data: { items, page: "invalid", page_size: 100 } }));
      if (["total0", "total50", "badtotal"].includes(mode)) return res.end(JSON.stringify({ success: true, data: { items, page, page_size: 100, total: mode === "total0" ? 0 : mode === "total50" ? 50 : "invalid" } }));
      return res.end(JSON.stringify({ success: true, data: { items, page: mode === "repeat" ? 1 : page, page_size: 100, total: ["cap", "partial", "repeat"].includes(mode) ? 600 : 2 } }));
    }
    res.statusCode = 404; res.end(secret);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  root = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
});
beforeEach(() => { mode = "perf"; calls.length = 0; });
afterAll(async () => {
  store.close(); server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  if (oldPrivate === undefined) delete process.env.RELAYDOCK_PRIVATE_HOSTS;
  else process.env.RELAYDOCK_PRIVATE_HOSTS = oldPrivate;
});
const create = (overrides = {}) => store.create({ name: "Model fixture", siteUrl: root, managementUrl: root + "/prefix/api/user/self", provider: "newapi", userId: "987654", credential: secret, initialBalance: "8.5", ...overrides });
function call(id: string, method = "POST", input: unknown = { hours: 24, source: "auto", routeMode: "direct" }, tail = "models", headers = {}) {
  return handleApi(new Request(`http://localhost/api/accounts/${id}/${tail}`, { method, headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf, ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(input) }) }), ["accounts", id, ...tail.split("/")], store);
}
it("GET reads only local cache; POST stores aggregate without touching account, history or backup", async () => {
  const account = create(), before = store.get(account.id), history = store.history(account.id);
  const get = await call(account.id, "GET");
  expect(get.status).toBe(200); expect(await get.json()).toEqual({ insight: null }); expect(calls).toHaveLength(0);
  const response = await call(account.id); expect(response.status).toBe(200);
  const data = await response.json();
  expect(data).toMatchObject({ version: 1, accountId: account.id, source: "perf", hours: 24, catalogAvailable: true, truncated: false });
  expect(data.rows[0]).toMatchObject({ model: "gpt-a", successRate: 96, vendor: "OpenAI" });
  expect(calls.every(c => c.method === "GET" && c.auth === undefined && c.user === undefined)).toBe(true);
  expect(calls.map(c => c.path.split("?")[0]).sort()).toEqual(["/prefix/api/perf-metrics/summary", "/prefix/api/pricing", "/prefix/api/status"]);
  expect((await (await call(account.id, "GET")).json()).insight).toEqual(data);
  expect(store.get(account.id)).toEqual(before); expect(store.history(account.id)).toEqual(history);
  expect(JSON.stringify(store.exportBackup())).not.toMatch(/model_insights|successRate|fixture-private/);
});
it("sends exactly one credential retry only after public HTTP 401", async () => {
  mode = "auth"; const a = create();
  const r = await call(a.id); expect(r.status).toBe(200);
  const perf = calls.filter(c => c.path.includes("perf-metrics"));
  expect(perf).toHaveLength(2);
  expect(perf[0].auth).toBeUndefined(); expect(perf[0].user).toBeUndefined();
  expect(perf[1]).toMatchObject({ auth: "Bearer " + secret, user: "987654" });
});
it("only HTTP 404 auto-falls back to bounded self logs with sanitized aggregates", async () => {
  const a = create(); mode = "missing";
  const r = await call(a.id); expect(r.status).toBe(200);
  const data = await r.json(); expect(data.source).toBe("log");
  expect(data.rows[0]).toMatchObject({ sampleCount: 2, successRate: 50, avgTps: 40 });
  expect(calls.filter(c => c.path.includes("log/self"))).toHaveLength(1);
  expect(JSON.stringify(data)).not.toMatch(/fixture-private|token_name|completion_tokens|content|prompt/);
  const db = new Database(dbPath); const cached = db.prepare("SELECT payload FROM model_insights WHERE account_id=?").get(a.id) as { payload: string }; db.close();
  expect(cached.payload).not.toMatch(/fixture-private|token_name|completion_tokens|content|prompt/);
  mode = "denied"; calls.length = 0;
  const denied = await call(a.id); expect(denied.status).toBe(502);
  expect((await denied.json()).error).toContain("权限");
  expect((await (await call(a.id, "GET")).json()).insight).toEqual(data);
  expect(calls.some(c => c.path.includes("log/self"))).toBe(false);
});
it("explicit log mode caps pages and marks a full last page incomplete", async () => {
  mode = "cap"; const a = create();
  const r = await call(a.id, "POST", { hours: 72, source: "log", routeMode: "direct" }); expect(r.status).toBe(200);
  const data = await r.json(); expect(data.truncated).toBe(true); expect(data.rows[0].sampleCount).toBe(600);
  const logs = calls.filter(c => c.path.includes("log/self")); expect(logs).toHaveLength(6);
  expect(logs.at(-1)?.path).toContain("p=6"); expect(logs.every(c => c.auth === "Bearer " + secret)).toBe(true);
  expect(calls.some(c => c.path.includes("perf-metrics"))).toBe(false);
});
it("protects cache and mutations, rejects unsupported/archived/extra inputs before networking", async () => {
  const a = create();
  expect((await call(a.id, "GET", undefined, "models", { cookie: "" })).status).toBe(401);
  expect((await call(a.id, "POST", undefined, "models", { "x-csrf-token": "" })).status).toBe(403);
  expect((await call(a.id, "POST", undefined, "models", { origin: "https://evil.example" })).status).toBe(403);
  for (const input of [{ hours: 12, source: "auto" }, { hours: 24, source: "auto", url: root }, { hours: 24, source: "log", credential: secret }]) expect((await call(a.id, "POST", input)).status).toBe(400);
  expect((await call(create({ provider: "newapi-token" }).id)).status).toBe(400);
  expect((await call(create({ archived: true }).id)).status).toBe(400);
  expect(calls).toHaveLength(0);
});
it("blocks private SSRF before any request and leaves previous cache and snapshots unchanged", async () => {
  const a = create(); await call(a.id); const cached = await (await call(a.id, "GET")).json();
  const account = store.get(a.id), history = store.history(a.id); calls.length = 0;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "";
  try {
    const r = await call(a.id); expect(r.status).toBe(502); expect(JSON.stringify(await r.json())).not.toContain(secret);
    expect(calls).toHaveLength(0); expect(await (await call(a.id, "GET")).json()).toEqual(cached);
    expect(store.get(a.id)).toEqual(account); expect(store.history(a.id)).toEqual(history);
  } finally { process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1"; }
});
it("detail is an explicit read with selected model encoded, no cache/balance write", async () => {
  const a = create(), account = store.get(a.id);
  const r = await call(a.id, "POST", { hours: 168, source: "perf", model: "gpt-a", routeMode: "direct" }, "models/detail");
  expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ version: 1, accountId: a.id, model: "gpt-a", hours: 168, source: "perf", groups: [{ group: "default", successRate: 96 }] });
  expect(calls).toHaveLength(1); expect(calls[0].path).toContain("model=gpt-a");
  expect(store.get(a.id)).toEqual(account); expect(await (await call(a.id, "GET")).json()).toEqual({ insight: null });
  expect((await call(a.id, "POST", { hours: 24, source: "perf", model: "x".repeat(201) }, "models/detail")).status).toBe(400);
});
it("ignores corrupt or wrong-identity caches and account deletion removes cache", async () => {
  const a = create(); expect((await call(a.id)).status).toBe(200);
  const db = new Database(dbPath); db.prepare("UPDATE model_insights SET payload=? WHERE account_id=?").run('{"token":"fixture-private-secret"}', a.id); db.close();
  expect(await (await call(a.id, "GET")).json()).toEqual({ insight: null });
  await call(a.id); store.remove(a.id);
  const check = new Database(dbPath); expect(check.prepare("SELECT count(*) AS n FROM model_insights WHERE account_id=?").get(a.id)).toEqual({ n: 0 }); check.close();
});
const edit = (id: string, changes: object) => {
  const current = store.get(id)!;
  const details = accountDetails.parse(Object.fromEntries(Object.keys(accountDetails.shape).map(key => [key, (current as unknown as Record<string, unknown>)[key]])));
  return store.update(id, { ...details, ...changes });
};
it("invalidates cache only for connection or credential changes and refuses an older in-flight result", async () => {
  const a = create(); await call(a.id);
  const oldCache = await (await call(a.id, "GET")).json();
  edit(a.id, { alias: "Renamed", group: "Moved" });
  expect(await (await call(a.id, "GET")).json()).toEqual(oldCache);
  edit(a.id, { userId: "321" });
  expect(await (await call(a.id, "GET")).json()).toEqual({ insight: null });
  await call(a.id); edit(a.id, { credential: "fixture-new-key" });
  expect(await (await call(a.id, "GET")).json()).toEqual({ insight: null });
  mode = "deferred";
  const started = new Promise<void>(resolve => { onDeferred = resolve; });
  const query = call(a.id); await started;
  edit(a.id, { managementUrl: root + "/other" });
  deferred!.end(JSON.stringify({ success: true, data: { models: [{ model_name: "obsolete", success_rate: 99 }] } }));
  expect((await query).status).toBe(409);
  expect(await (await call(a.id, "GET")).json()).toEqual({ insight: null });
  expect(store.history(a.id)).toHaveLength(1);
  deferred = undefined; onDeferred = undefined;
});
it("marks truncation when separately bounded catalog and metrics exceed the merged row cap", async () => {
  mode = "union"; const a = create(); const r = await call(a.id);
  expect(r.status).toBe(200); const insight = await r.json();
  expect(insight.rows).toHaveLength(500); expect(insight.truncated).toBe(true);
  expect(insight.warnings.join(" ")).toContain("采样上限");
});
it("supports legacy log arrays and rejects malformed page metadata rather than trusting its samples", async () => {
  const a = create(); mode = "array";
  const r = await call(a.id, "POST", { hours: 24, source: "log", routeMode: "direct" }); expect(r.status).toBe(200);
  const cached = await r.json(); expect(cached.rows[0].sampleCount).toBe(2);
  mode = "badpage";
  const bad = await call(a.id, "POST", { hours: 24, source: "log", routeMode: "direct" }); expect(bad.status).toBe(502);
  expect((await (await call(a.id, "GET")).json()).insight).toEqual(cached);
});
it.each(["partial", "repeat"])("marks %s log pagination incomplete without re-counting pages or raw errors", async kind => {
  const a = create(); mode = kind;
  const r = await call(a.id, "POST", { hours: 24, source: "log", routeMode: "direct" }); expect(r.status).toBe(200);
  const insight = await r.json(); expect(insight.truncated).toBe(true); expect(insight.rows[0].sampleCount).toBe(100);
  expect(calls.filter(c => c.path.includes("log/self"))).toHaveLength(2);
  expect(JSON.stringify(insight)).not.toContain(secret);
});
it("locks the same database/account while independent database copies stay independent", async () => {
  const a = create(); mode = "deferred";
  const started = new Promise<void>(resolve => { onDeferred = resolve; });
  const pending = call(a.id); await started;
  const second = new Store(dbPath, Buffer.alloc(32, 7));
  try {
    const req = new Request(`http://localhost/api/accounts/${a.id}/models`, { method: "POST", headers: { origin: "http://localhost", cookie: "atlas_session=" + raw, "x-csrf-token": csrf }, body: JSON.stringify({ hours: 24, source: "auto", routeMode: "direct" }) });
    expect((await handleApi(req, ["accounts", a.id, "models"], second)).status).toBe(409);
    const clone = new Store(join(dir, "independent.sqlite"), Buffer.alloc(32, 7));
    clone.createSession(tokenHash(raw), csrf);
    const cloned = clone.create({ name: "Independent", siteUrl: root, managementUrl: root + "/prefix", provider: "newapi", credential: secret });
    mode = "perf";
    const clonedRequest = new Request(`http://localhost/api/accounts/${cloned.id}/models`, { method: "POST", headers: { origin: "http://localhost", cookie: "atlas_session=" + raw, "x-csrf-token": csrf }, body: JSON.stringify({ hours: 24, source: "auto", routeMode: "direct" }) });
    try { expect((await handleApi(clonedRequest, ["accounts", cloned.id, "models"], clone)).status).toBe(200); } finally { clone.close(); }
  } finally {
    second.close(); deferred!.end(JSON.stringify({ success: true, data: { models: [] } })); await pending; deferred = undefined; onDeferred = undefined;
  }
});
it("shares one absolute deadline across status/catalog/metrics instead of refreshing each request's budget", async () => {
  const a = create(); const success = await call(a.id); expect(success.status).toBe(200); const cached = await success.json();
  mode = "deadline"; const began = performance.now();
  const response = await call(a.id); const elapsed = performance.now() - began;
  expect(response.status).toBe(502); expect((await response.json()).error).toContain("超时");
  expect(elapsed).toBeGreaterThanOrEqual(9800); expect(elapsed).toBeLessThan(10850);
  expect((await (await call(a.id, "GET")).json()).insight).toEqual(cached); expect(store.history(a.id)).toHaveLength(1);
}, 14000);
it("captures account connection and credential together after an asynchronous request body has arrived", async () => {
  const a = create();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const req = new Request(`http://localhost/api/accounts/${a.id}/models`, { method: "POST", headers: { origin: "http://localhost", cookie: "atlas_session=" + raw, "x-csrf-token": csrf }, body, duplex: "half" } as RequestInit);
  const pending = handleApi(req, ["accounts", a.id, "models"], store);
  edit(a.id, { userId: "345", credential: "fixture-new-credential" });
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ hours: 24, source: "log", routeMode: "direct" }))); controller.close();
  expect((await pending).status).toBe(200);
  expect(calls.filter(c => c.path.includes("log/self"))[0]).toMatchObject({ user: "345", auth: "Bearer fixture-new-credential" });
});
it.each(["total0", "total50", "badtotal"])("rejects %s total metadata that contradicts the returned page without overwriting cache", async kind => {
  const a = create(); const r = await call(a.id); const cached = await r.json(); mode = kind;
  expect((await call(a.id, "POST", { hours: 24, source: "log", routeMode: "direct" })).status).toBe(502);
  expect((await (await call(a.id, "GET")).json()).insight).toEqual(cached);
});
it("rejects aggregate cache writes larger than its serialized read bound and preserves the existing cache", async () => {
  const a = create(); const existing = await (await call(a.id)).json();
  const metric = Number.MAX_SAFE_INTEGER;
  const point = { at: "2026-10-08T08:00:00.000Z", successRate: 100, avgLatencyMs: metric, avgTtftMs: metric, avgTps: metric };
  const large = { ...existing, rows: Array.from({ length: 500 }, (_, i) => ({ ...existing.rows[0], model: `model-${i}-` + "a".repeat(180), vendor: "b".repeat(200), groups: Array.from({ length: 32 }, (_, j) => `group-${j}-` + "\u6a21".repeat(180)), trend: Array.from({ length: 168 }, () => point) })) };
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(16 * 1024 * 1024);
  expect(() => store.saveModelInsight(a.id, large)).toThrow();
  expect((await (await call(a.id, "GET")).json()).insight).toEqual(existing);
});
