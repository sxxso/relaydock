import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { accountDetails } from "../src/lib/validation";
import { checkinIdentity } from "../src/lib/query-checkin";
import { checkinSubmitInput } from "../src/lib/query-checkin";
it("rejects caller chosen endpoint/method/body before mutation", () => {
  expect(checkinSubmitInput.safeParse({ refreshBalance: false, url: "https://evil.example", method: "POST", body: {} }).success).toBe(false);
});

let server: Server, root: string, store: Store, dir: string, dbPath: string;
let mode = "unsigned", nextUser = 100, deferred: ServerResponse | undefined, onDeferred: (() => void) | undefined;
const signed = new Set<string>();
const calls: { path: string; method: string; auth?: string; user: string; body: string }[] = [];
const secret = "checkin-fixture-private-secret", raw = "c".repeat(64), csrf = "d".repeat(48);
const oldPrivate = process.env.RELAYDOCK_PRIVATE_HOSTS;
let active = 0, peak = 0;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-checkin-")); dbPath = join(dir, "fixture.sqlite");
  store = new Store(dbPath, Buffer.alloc(32, 8)); store.createSession(tokenHash(raw), csrf);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url!, root), user = String(req.headers["new-api-user"] || "");
      calls.push({ path: url.pathname + url.search, method: req.method!, auth: req.headers.authorization, user, body });
      active++; peak = Math.max(peak, active); res.once("close", () => { active--; });
      res.setHeader("Content-Type", "application/json");
      if (url.pathname.endsWith("/api/user/self")) {
        if (mode === "balanceFail") { res.statusCode = 500; res.end(secret); return; }
        res.end(JSON.stringify({ success: true, data: { quota: 125000 } })); return;
      }
      if (!url.pathname.endsWith("/api/user/checkin")) { res.statusCode = 404; res.end(secret); return; }
      if (req.method === "GET") {
        if (mode === "deferred") { deferred = res; onDeferred?.(); return; }
        if (["missing", "auth", "denied"].includes(mode)) { res.statusCode = mode === "missing" ? 404 : mode === "auth" ? 401 : 403; res.end(secret); return; }
        if (mode === "challenge") { res.setHeader("Content-Type", "text/html"); res.end('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform"></script></html>'); return; }
        if (mode === "disabled") { res.end(JSON.stringify({ success: false, message: "签到功能未启用" })); return; }
        if (mode === "businessGet") { res.end(JSON.stringify({ success: false, message: secret })); return; }
        const month = url.searchParams.get("month") || "2026-10", checked = signed.has(user) || mode === "signed";
        const records = [{ checkin_date: month + "-01", quota_awarded: 10 }, ...(checked ? [{ checkin_date: month + "-08", quota_awarded: 20 }] : [])];
        const reply = { success: true, data: { enabled: true, min_quota: 10, max_quota: 20, stats: { checked_in_today: checked, records, checkin_count: records.length, total_checkins: 9 + Number(checked), total_quota: 90 + Number(checked) * 20 } } };
        const send = () => res.end(JSON.stringify(reply));
        if (mode === "deadline") { const timer = setTimeout(send, 1200); res.once("close", () => clearTimeout(timer)); return; }
        if (mode === "slow") { setTimeout(send, 40); return; }
        send(); return;
      }
      if (mode === "deferredPost") { deferred = res; onDeferred?.(); return; }
      if (mode === "deadline") {
        const timer = setTimeout(() => res.end(JSON.stringify({ success: true, data: { checkin_date: "2026-10-08", quota_awarded: 20 } })), 9500);
        res.once("close", () => clearTimeout(timer)); return;
      }
      if (mode === "drop") { req.socket.destroy(); return; }
      if (mode === "500" || mode === "postDenied") { res.statusCode = mode === "500" ? 500 : 403; res.end(secret); return; }
      if (mode === "malformed") { res.end(JSON.stringify({ success: true, data: { checkin_date: "2026-02-30", quota_awarded: 20, secret } })); return; }
      if (mode === "business" || mode === "already" || mode === "disabledPost") { res.end(JSON.stringify({ success: false, message: mode === "already" ? "今日已签到" : mode === "disabledPost" ? "签到功能未启用" : secret })); return; }
      signed.add(user);
      res.end(JSON.stringify({ success: true, data: { checkin_date: "2026-10-08", quota_awarded: 20, secret } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  root = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
});
beforeEach(() => { mode = "unsigned"; signed.clear(); calls.length = 0; active = 0; peak = 0; deferred = undefined; onDeferred = undefined; });
afterAll(async () => {
  store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  if (oldPrivate === undefined) delete process.env.RELAYDOCK_PRIVATE_HOSTS; else process.env.RELAYDOCK_PRIVATE_HOSTS = oldPrivate;
});
const create = (changes = {}) => store.create({ name: "Checkin fixture", siteUrl: root, managementUrl: root + "/prefix/api/user/self", provider: "newapi", userId: String(nextUser++), credential: secret, initialBalance: "7.25", quotaPerUnit: "10000", unit: "CNY", ...changes });
function request(path: string[], method = "POST", input: unknown = { refreshBalance: false, routeMode: "direct" }, headers = {}, query = "") {
  return handleApi(new Request("http://localhost/api/" + path.join("/") + query, { method, headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf, ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(input) }) }), path, store);
}
const submit = (id: string, refreshBalance = false) => request(["accounts", id, "checkin"], "POST", { refreshBalance, routeMode: "direct" });
const status = (id: string, month?: string) => request(["accounts", id, "checkin", "status"], "POST", { routeMode: "direct", ...(month ? { month } : {}) });
const local = (id: string, month?: string) => request(["accounts", id, "checkin"], "GET", undefined, {}, month ? "?month=" + month : "");
const batch = (ids: string[]) => request(["checkin", "batch"], "POST", { ids, refreshBalance: false, routeMode: "direct" });
const edit = (id: string, changes: object) => {
  const current = store.get(id)!;
  const details = accountDetails.parse(Object.fromEntries(Object.keys(accountDetails.shape).map(key => [key, (current as unknown as Record<string, unknown>)[key]])));
  return store.update(id, { ...details, ...changes });
};
it("cache GET is local-only; explicit read caches safe monthly data without changing balance", async () => {
  const a = create(), before = store.get(a.id), history = store.history(a.id);
  expect(await (await local(a.id)).json()).toEqual({ status: null, operations: [], uncertain: false }); expect(calls).toHaveLength(0);
  const r = await status(a.id, "2026-10"); expect(r.status).toBe(200);
  const data = await r.json(); expect(data).toMatchObject({ state: "unsigned", month: "2026-10", monthSource: "requested", quotaPerUnit: "10000", unit: "CNY" });
  expect((await (await local(a.id, "2026-10")).json()).status).toEqual(data);
  expect(calls).toEqual([{ path: "/prefix/api/user/checkin?month=2026-10", method: "GET", auth: "Bearer " + secret, user: a.userId, body: "" }]);
  expect(store.get(a.id)).toEqual(before); expect(store.history(a.id)).toEqual(history);
});
it("checks current site state then submits exactly one empty POST; reward never adds to balance", async () => {
  const a = create(), history = store.history(a.id);
  const r = await submit(a.id); expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ accountId: a.id, outcome: "success", status: { state: "signed", monthCount: 2, totalCheckins: 10, totalQuota: 110 }, operation: { date: "2026-10-08", quotaAwarded: 20 } });
  expect(calls.map(c => [c.method, c.path, c.body])).toEqual([["GET", "/prefix/api/user/checkin", ""], ["POST", "/prefix/api/user/checkin", "{}"]]);
  expect(store.get(a.id)?.balance).toBe("7.25"); expect(store.history(a.id)).toEqual(history);
  calls.length = 0; expect((await (await submit(a.id)).json()).outcome).toBe("already_signed");
  expect(calls.map(c => c.method)).toEqual(["GET"]);
});
it.each(["signed", "disabled", "missing", "auth", "denied", "challenge", "businessGet"])("preflight %s never submits or echoes private body", async value => {
  mode = value; const a = create();
  const data = await (await submit(a.id)).json();
  const outcome = value === "signed" ? "already_signed" : value === "disabled" ? "disabled" : value === "missing" ? "unsupported" : ["auth", "denied", "challenge"].includes(value) ? "needs_web" : "failed";
  expect(data.outcome).toBe(outcome); expect(calls.map(c => c.method)).toEqual(["GET"]);
  expect(JSON.stringify(data)).not.toContain(secret); expect((await (await local(a.id)).json()).uncertain).toBe(false);
});
it.each(["business", "already", "disabledPost", "postDenied"])("definitive POST %s has a fixed result without an uncertain barrier", async value => {
  mode = value; const a = create();
  const data = await (await submit(a.id)).json();
  expect(data.outcome).toBe(value === "already" ? "already_signed" : value === "disabledPost" ? "disabled" : value === "postDenied" ? "needs_web" : "failed");
  expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
  expect((await (await local(a.id)).json()).uncertain).toBe(false); expect(JSON.stringify(data)).not.toContain(secret);
});
it.each(["malformed", "drop", "500"])("ambiguous POST %s survives restart and duplicate cards and cannot retry on false GET", async value => {
  mode = value; const a = create(), duplicate = create({ userId: a.userId });
  expect((await (await submit(a.id)).json()).outcome).toBe("uncertain");
  const identity = checkinIdentity(store.modelInsightConnection(a.id)!.account);
  expect(store.hasCheckinBarrier(identity)).toBe(true);
  store.close(); store = new Store(dbPath, Buffer.alloc(32, 8));
  mode = "unsigned"; calls.length = 0;
  expect((await (await submit(duplicate.id)).json()).outcome).toBe("uncertain");
  expect(calls.map(c => c.method)).toEqual(["GET"]);
  expect((await (await status(duplicate.id)).json()).state).toBe("uncertain");
  store.remove(a.id); expect(store.hasCheckinBarrier(identity)).toBe(true);
  mode = "signed";
  expect((await (await status(duplicate.id)).json()).state).toBe("signed"); expect(store.hasCheckinBarrier(identity)).toBe(false);
});
it("optional balance refresh records only actual remote balance; failure keeps successful signin", async () => {
  const a = create(); const before = store.history(a.id).length;
  const data = await (await submit(a.id, true)).json();
  expect(data).toMatchObject({ outcome: "success", account: { balance: "12.5", balanceUnit: "CNY" }, balanceRefresh: { outcome: "success" } });
  expect(store.history(a.id)).toHaveLength(before + 1);
  expect(calls.map(c => c.path)).toEqual(["/prefix/api/user/checkin", "/prefix/api/user/checkin", "/prefix/api/user/self"]);
  mode = "balanceFail"; const b = create(), history = store.history(b.id);
  expect(await (await submit(b.id, true)).json()).toMatchObject({ outcome: "success", balanceRefresh: { outcome: "failed" } });
  expect(store.get(b.id)?.balance).toBe("7.25"); expect(store.history(b.id)).toEqual(history);
});
it("keeps null quota conversion and arbitrary configured units", async () => {
  const a = create({ quotaPerUnit: null, unit: "积分" });
  expect(await (await status(a.id)).json()).toMatchObject({ quotaPerUnit: null, unit: "积分", totalQuota: 90 });
});
it("protects login/CSRF/origin and validates month/schema before networking", async () => {
  const a = create(), path = ["accounts", a.id, "checkin"];
  expect((await request(path, "GET", undefined, { cookie: "" })).status).toBe(401);
  expect((await request(path, "POST", { refreshBalance: false }, { "x-csrf-token": "" })).status).toBe(403);
  expect((await request(path, "POST", { refreshBalance: false }, { origin: "https://evil.example" })).status).toBe(403);
  expect((await status(a.id, "2026-13")).status).toBe(400);
  expect((await local(a.id, "2026-00")).status).toBe(400);
  expect((await request(path, "POST", { refreshBalance: false, url: root })).status).toBe(400);
  expect((await batch([a.id, a.id])).status).toBe(400); expect(calls).toHaveLength(0);
});
it("skips archived unsupported missing management credential and missing user IDs", async () => {
  const a = create({ archived: true }), b = create({ provider: "newapi-token" }), c = create({ credential: "" }), d = create({ userId: "" });
  const data = await (await batch([a.id, b.id, c.id, d.id, "absent"])).json();
  expect(data.results.map((r: { outcome: string }) => r.outcome)).toEqual(["archived", "unsupported", "missing_credential", "missing_identity", "missing"]); expect(calls).toHaveLength(0);
});
it("deduplicates same site/user and serializes different users on the same site", async () => {
  mode = "slow"; const a = create(), b = create(), duplicate = create({ userId: "00" + a.userId });
  const data = await (await batch([a.id, b.id, duplicate.id])).json();
  expect(data.results.map((r: { outcome: string }) => r.outcome)).toEqual(["success", "success", "duplicate"]);
  expect(calls.filter(c => c.method === "POST")).toHaveLength(2); expect(peak).toBe(1);
});
it("rejects overlapping account/site operations while a GET is in flight", async () => {
  mode = "deferred"; const a = create(), b = create();
  const started = new Promise<void>(r => { onDeferred = r; }); const pending = submit(a.id); await started;
  expect((await (await submit(a.id)).json()).outcome).toBe("busy"); expect((await (await submit(b.id)).json()).outcome).toBe("busy");
  expect((await status(a.id)).status).toBe(409); expect(calls).toHaveLength(1);
  mode = "unsigned"; deferred!.end(JSON.stringify({ success: true, data: { enabled: false } })); await pending;
});
it.each(["sync", "test"])("rechecks %s exclusion after a delayed request body completes", async action => {
  const a = create(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const req = new Request("http://localhost/api/accounts/" + a.id + "/" + action, { method: "POST", headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf }, body: stream, duplex: "half" } as RequestInit);
  const balance = handleApi(req, ["accounts", a.id, action], store);
  expect(req.bodyUsed).toBe(true);
  mode = "deferred";
  const started = new Promise<void>(resolve => { onDeferred = resolve; });
  const readingStatus = status(a.id); await started;
  try {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ routeMode: "direct" }))); controller.close();
    const response = await balance;
    expect(response.status).toBe(409);
    expect(calls.map(call => [call.method, call.path])).toEqual([["GET", "/prefix/api/user/checkin"]]);
  } finally {
    deferred!.end(JSON.stringify({ success: true, data: { enabled: false } }));
    await readingStatus; await balance;
  }
  mode = "unsigned";
  expect((await status(a.id)).status).toBe(200);
  expect((await request(["accounts", a.id, action], "POST", { routeMode: "direct" })).status).toBe(200);
});
it("rechecks config after preflight before POST and never caches old results on the new connection", async () => {
  mode = "deferred"; const a = create();
  const started = new Promise<void>(r => { onDeferred = r; }); const pending = submit(a.id); await started;
  edit(a.id, { userId: "9999999" });
  deferred!.end(JSON.stringify({ success: true, data: { enabled: true, stats: { checked_in_today: false, records: [], checkin_count: 0 } } }));
  expect((await (await pending).json()).outcome).toBe("changed"); expect(calls.map(c => c.method)).toEqual(["GET"]);
  expect(await (await local(a.id)).json()).toEqual({ status: null, operations: [], uncertain: false });
});
it("captures configuration after an asynchronous request body completes", async () => {
  const a = create(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const req = new Request("http://localhost/api/accounts/" + a.id + "/checkin", { method: "POST", headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf }, body: stream, duplex: "half" } as RequestInit);
  const pending = handleApi(req, ["accounts", a.id, "checkin"], store);
  edit(a.id, { userId: "876543" }); controller.enqueue(new TextEncoder().encode(JSON.stringify({ refreshBalance: false, routeMode: "direct" }))); controller.close();
  expect((await (await pending).json()).outcome).toBe("success"); expect(calls.every(c => c.user === "876543")).toBe(true);
});
it("alias/group preserve caches; unit/credential/connection changes invalidate private results", async () => {
  const a = create(); await submit(a.id); const cached = await (await local(a.id)).json();
  edit(a.id, { name: "Renamed", group: "Group" }); expect(await (await local(a.id)).json()).toEqual(cached);
  edit(a.id, { quotaPerUnit: "20000" }); expect(await (await local(a.id)).json()).toEqual({ status: null, operations: [], uncertain: false });
});
it("cached current month follows most recent update even when an older month existed", async () => {
  const a = create(); await status(a.id, "2026-10"); await status(a.id, "2026-09"); await status(a.id, "2026-10");
  expect((await (await local(a.id)).json()).status.month).toBe("2026-10");
  expect((await (await local(a.id, "2026-09")).json()).status.month).toBe("2026-09");
});
it("malformed cache/operations are ignored; FK deletion cascades; backup remains compatible", async () => {
  const a = create(); await submit(a.id);
  expect(JSON.stringify(store.exportBackup())).not.toMatch(/checkin_|quotaAwarded|checkin-fixture-private-secret/);
  const db = new Database(dbPath); db.prepare("UPDATE checkin_cache SET payload=? WHERE account_id=?").run(JSON.stringify({ secret }), a.id); db.prepare("UPDATE checkin_operations SET payload=? WHERE account_id=?").run(JSON.stringify({ secret }), a.id); db.close();
  expect(await (await local(a.id)).json()).toEqual({ status: null, operations: [], uncertain: false });
  store.remove(a.id); const db2 = new Database(dbPath);
  expect(db2.prepare("SELECT count(*) n FROM checkin_cache WHERE account_id=?").get(a.id)).toEqual({ n: 0 }); expect(db2.prepare("SELECT count(*) n FROM checkin_operations WHERE account_id=?").get(a.id)).toEqual({ n: 0 }); db2.close();
});
it("blocks unsafe private target without external requests or sign-in barriers", async () => {
  const a = create(); process.env.RELAYDOCK_PRIVATE_HOSTS = "";
  try { expect((await (await submit(a.id)).json()).outcome).toBe("failed"); expect(calls).toHaveLength(0); expect((await (await local(a.id)).json()).uncertain).toBe(false); }
  finally { process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1"; }
});
it("retains at most 100 safe operations without raw provider data", async () => {
  mode = "signed"; const a = create();
  for (let i = 0; i < 102; i++) await submit(a.id);
  const operations = (await (await local(a.id)).json()).operations;
  expect(operations).toHaveLength(100); expect(JSON.stringify(operations)).not.toContain(secret);
});
it("batch limits cross-site concurrency to three and preserves result order", async () => {
  mode = "slow";
  const accounts = Array.from({ length: 5 }, (_, i) => create({ managementUrl: root + "/site-" + i + "/api/user/self" }));
  const data = await (await batch(accounts.map(a => a.id))).json();
  expect(data.results.map((r: { accountId: string }) => r.accountId)).toEqual(accounts.map(a => a.id));
  expect(data.results.every((r: { outcome: string }) => r.outcome === "success")).toBe(true);
  expect(peak).toBe(3);
});
it("shares locks between Store handles for the same database", async () => {
  mode = "deferred"; const a = create();
  const started = new Promise<void>(r => { onDeferred = r; }); const pending = submit(a.id); await started;
  const second = new Store(dbPath, Buffer.alloc(32, 8));
  try {
    const response = await handleApi(new Request("http://localhost/api/accounts/" + a.id + "/checkin", { method: "POST", headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf }, body: JSON.stringify({ refreshBalance: false, routeMode: "direct" }) }), ["accounts", a.id, "checkin"], second);
    expect((await response.json()).outcome).toBe("busy"); expect(calls).toHaveLength(1);
  } finally { second.close(); deferred!.end(JSON.stringify({ success: true, data: { enabled: false } })); await pending; }
});
it("unknown POST during configuration change retains original identity barrier without attaching old reward", async () => {
  mode = "deferredPost"; const a = create(), duplicate = create({ userId: a.userId });
  const oldIdentity = checkinIdentity(store.modelInsightConnection(a.id)!.account);
  const started = new Promise<void>(r => { onDeferred = r; }); const pending = submit(a.id); await started;
  expect(store.hasCheckinBarrier(oldIdentity)).toBe(true);
  edit(a.id, { userId: "9999991" }); deferred!.statusCode = 500; deferred!.end(secret);
  expect((await (await pending).json()).outcome).toBe("changed");
  expect(store.hasCheckinBarrier(oldIdentity)).toBe(true);
  expect(await (await local(a.id)).json()).toEqual({ status: null, operations: [], uncertain: false });
  mode = "unsigned"; calls.length = 0;
  expect((await (await submit(duplicate.id)).json()).outcome).toBe("uncertain"); expect(calls.map(c => c.method)).toEqual(["GET"]);
});
it("archive change after preflight prevents submission", async () => {
  mode = "deferred"; const a = create();
  const started = new Promise<void>(r => { onDeferred = r; }); const pending = submit(a.id); await started;
  edit(a.id, { archived: true });
  deferred!.end(JSON.stringify({ success: true, data: { enabled: true, stats: { checked_in_today: false, records: [], checkin_count: 0 } } }));
  expect((await (await pending).json()).outcome).toBe("changed"); expect(calls.map(c => c.method)).toEqual(["GET"]);
});
it("old database tables migrate additively without changing snapshots or backup format", () => {
  const path = join(dir, "old.sqlite"), db = new Database(path);
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,secret TEXT); CREATE TABLE snapshots(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,payload TEXT NOT NULL,at TEXT NOT NULL)"); db.close();
  const migrated = new Store(path, Buffer.alloc(32, 8));
  try {
    expect(migrated.list()).toEqual([]); expect(migrated.history()).toEqual([]);
    expect(migrated.exportBackup()).not.toHaveProperty("checkin");
    const inspect = new Database(path); const names = (inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(v => v.name); inspect.close();
    expect(names).toEqual(expect.arrayContaining(["checkin_cache", "checkin_operations", "checkin_barriers", "snapshots"]));
  } finally { migrated.close(); }
});
it("one shared deadline covers preflight and POST timeout; unknown submission stays barred", async () => {
  mode = "deadline"; const a = create(); const started = performance.now();
  expect((await (await submit(a.id)).json()).outcome).toBe("uncertain");
  expect(performance.now() - started).toBeLessThan(10800);
  expect(calls.map(c => c.method)).toEqual(["GET", "POST"]);
  expect((await (await local(a.id)).json()).uncertain).toBe(true);
  mode = "unsigned"; calls.length = 0;
  expect((await (await submit(a.id)).json()).outcome).toBe("uncertain"); expect(calls.map(c => c.method)).toEqual(["GET"]);
}, 15000);
