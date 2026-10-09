import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { accountDetails } from "../src/lib/validation";
let server: Server, store: Store, dir: string, root: string, dbPath: string;
let mode = "ok", deferred: ServerResponse | undefined, entered: (() => void) | undefined;
const raw = "a".repeat(64), csrf = "b".repeat(48), secret = "invitation-fixture-private-pat";
const prior = process.env.RELAYDOCK_PRIVATE_HOSTS;
const calls: { path: string; method?: string; auth?: string; user: string }[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-invitation-")); dbPath = join(dir, "fixture.sqlite");
  store = new Store(dbPath, Buffer.alloc(32, 8)); store.createSession(tokenHash(raw), csrf);
  server = createServer((req, res) => {
    calls.push({ path: req.url!, method: req.method, auth: req.headers.authorization, user: String(req.headers["new-api-user"] || "") });
    res.setHeader("Content-Type", "application/json");
    if (mode === "deferred") { deferred = res; entered?.(); return; }
    if (mode === "404" || mode === "401" || mode === "403" || mode === "500") { res.statusCode = Number(mode); res.end(secret); return; }
    if (mode === "html") { res.setHeader("Content-Type", "text/html"); res.end("<html>" + secret + "</html>"); return; }
    if (mode === "bad") { res.end(JSON.stringify({ success: true, data: { code: "X12" }, secret })); return; }
    if (mode === "echo") { res.end(JSON.stringify({ success: true, data: secret })); return; }
    if (mode === "business") { res.end(JSON.stringify({ success: false, message: secret })); return; }
    res.end(JSON.stringify({ success: true, data: "Ab12", secret }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  root = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
});
beforeEach(() => { calls.length = 0; mode = "ok"; deferred = undefined; entered = undefined; });
afterAll(async () => {
  store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  if (prior === undefined) delete process.env.RELAYDOCK_PRIVATE_HOSTS; else process.env.RELAYDOCK_PRIVATE_HOSTS = prior;
});
const create = (changes = {}) => store.create({ name: "Invitation fixture", siteUrl: "https://public.example/prefix/", managementUrl: root + "/prefix/api/user/self", provider: "newapi", userId: "25", credential: secret, ...changes });
function request(id: string, method = "GET", input?: unknown, fetch = false, headers = {}) {
  const path = ["accounts", id, "invitation", ...(fetch ? ["fetch"] : [])];
  return handleApi(new Request("http://localhost/api/" + path.join("/"), { method, headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf, ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify({ ...(input as object), expectedUpdatedAt: store.get(id)?.updatedAt }) }) }), path, store);
}
const fetchCode = (id: string, revision = 0) => request(id, "POST", { expectedRevision: revision, routeMode: "direct" }, true);
const save = (id: string, manualUrl: string, revision = 0, registerUrl = "") => request(id, "PATCH", { manualUrl, registerUrl, expectedRevision: revision });
const edit = (id: string, changes: object) => {
  const current = store.get(id)!;
  const details = accountDetails.parse(Object.fromEntries(Object.keys(accountDetails.shape).map(key => [key, (current as unknown as Record<string, unknown>)[key]])));
  return store.update(id, { ...details, ...changes });
};
it("opening reads only local cache; explicit POST issues one fixed generating GET and saves safe result", async () => {
  const a = create(), accountBefore = store.get(a.id), history = store.history(a.id);
  expect((await (await request(a.id)).json()).invitation.fetched).toBeNull(); expect(calls).toHaveLength(0);
  const response = await fetchCode(a.id); expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.invitation).toMatchObject({ accountId: a.id, revision: 1, manualUrl: "", fetched: { code: "Ab12", url: "https://public.example/sign-up?aff=Ab12" } });
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(calls).toEqual([{ path: "/prefix/api/user/aff", method: "GET", auth: "Bearer " + secret, user: "25" }]);
  expect(await (await request(a.id)).json()).toEqual(body); expect(calls).toHaveLength(1);
  expect(store.get(a.id)).toEqual(accountBefore); expect(store.history(a.id)).toEqual(history);
});
it("manual override persists and is not overwritten; custom registration base is passive", async () => {
  const a = create(), manual = "https://public.example/invite?aff=MANUAL";
  expect((await save(a.id, manual, 0, "https://join.example/signup?lang=zh")).status).toBe(200); expect(calls).toHaveLength(0);
  const response = await fetchCode(a.id, 1); expect(response.status).toBe(200);
  expect((await response.json()).invitation).toMatchObject({ manualUrl: manual, fetched: { url: "https://join.example/signup?lang=zh&aff=Ab12" } });
  expect((await save(a.id, "", 2)).status).toBe(200);
  expect(store.invitation(a.id).fetched?.url).toBe("https://public.example/sign-up?aff=Ab12");
  const other = new Store(dbPath, Buffer.alloc(32, 8)); expect(other.invitation(a.id)).toEqual(store.invitation(a.id)); other.close();
});
it.each(["404", "401", "403", "500", "html", "bad", "business", "echo"])("safe %s outcome retains manual data and never exposes bodies", async value => {
  const a = create(); await save(a.id, "https://public.example/invite?aff=keep"); mode = value;
  const r = await fetchCode(a.id, 1); expect(r.status).toBe(502); expect(await r.text()).not.toContain(secret);
  expect(store.invitation(a.id).manualUrl).toContain("aff=keep"); expect(store.invitation(a.id).fetched).toBeNull(); expect(calls).toHaveLength(1);
});
it.each([{ provider: "manual" }, { provider: "newapi-token" }, { archived: true }, { credential: "" }, { userId: "" }])("refuses unsupported/inactive or missing management identity locally", async changes => {
  const a = create(changes); expect((await fetchCode(a.id)).status).toBe(400); expect(calls).toHaveLength(0);
});
it("requires login, CSRF, strict bounded commands and public links", async () => {
  const a = create();
  expect((await request(a.id, "POST", { expectedRevision: 0 }, true, { cookie: "" })).status).toBe(401);
  expect((await request(a.id, "POST", { expectedRevision: 0 }, true, { "x-csrf-token": "" })).status).toBe(403);
  expect((await request(a.id, "POST", { expectedRevision: 0, url: root }, true)).status).toBe(400);
  expect((await save(a.id, "https://public.example/?token=private")).status).toBe(400);
  expect((await request(a.id, "POST", { expectedRevision: 0, padding: "x".repeat(17000) }, true)).status).toBe(413);
  expect(calls).toHaveLength(0);
});
it("delayed fetch rejects duplicate, balance/checkin concurrency and stale connection", async () => {
  const a = create(); mode = "deferred";
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = fetchCode(a.id); await started;
  expect((await fetchCode(a.id)).status).toBe(409);
  const balance = await handleApi(new Request("http://localhost/api/accounts/" + a.id + "/test", { method: "POST", headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf }, body: "{}" }), ["accounts", a.id, "test"], store);
  expect(balance.status).toBe(409);
  const checkin = await handleApi(new Request("http://localhost/api/accounts/" + a.id + "/checkin", { method: "POST", headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf }, body: '{"refreshBalance":false}' }), ["accounts", a.id, "checkin"], store);
  expect((await checkin.json()).outcome).toBe("busy");
  edit(a.id, { userId: "26" }); deferred!.end(JSON.stringify({ success: true, data: "OLD" }));
  expect((await pending).status).toBe(409); expect(store.invitation(a.id).fetched).toBeNull(); expect(calls).toHaveLength(1);
});
it("late fetched data cannot overwrite newer manual edits", async () => {
  const a = create(); mode = "deferred";
  const started = new Promise<void>(resolve => { entered = resolve; }); const pending = fetchCode(a.id); await started;
  await save(a.id, "https://public.example/?aff=latest"); deferred!.end(JSON.stringify({ success: true, data: "OLD" }));
  expect((await pending).status).toBe(409); expect(store.invitation(a.id).manualUrl).toContain("aff=latest");
});
it.each(["save", "fetch"])("rejects old %s commands after a delayed body and identity change", async action => {
  const a = create(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const path = ["accounts", a.id, "invitation", ...(action === "fetch" ? ["fetch"] : [])];
  const req = new Request("http://localhost/api/" + path.join("/"), { method: action === "fetch" ? "POST" : "PATCH", headers: { cookie: "atlas_session=" + raw, origin: "http://localhost", "x-csrf-token": csrf }, body: stream, duplex: "half" } as RequestInit);
  const pending = handleApi(req, path, store);
  await Promise.resolve(); edit(a.id, { userId: "999" });
  const command = action === "fetch" ? { expectedRevision: 0, expectedUpdatedAt: a.updatedAt, routeMode: "direct" } : { expectedRevision: 0, expectedUpdatedAt: a.updatedAt, manualUrl: "https://public.example/?aff=OLD", registerUrl: "" };
  controller.enqueue(new TextEncoder().encode(JSON.stringify(command))); controller.close();
  expect((await pending).status).toBe(409); expect(store.invitation(a.id).manualUrl).toBe(""); expect(calls).toHaveLength(0);
});
it("credential changes invalidate fetched cache; identity changes hide manual values; deletion cascades", async () => {
  const a = create(); await save(a.id, "https://public.example/?aff=manual"); await fetchCode(a.id, 1);
  edit(a.id, { credential: "new-fixture-secret" }); expect(store.invitation(a.id).fetched).toBeNull(); expect(store.invitation(a.id).manualUrl).toContain("aff=manual");
  edit(a.id, { userId: "99" }); expect(store.invitation(a.id).manualUrl).toBe("");
  store.remove(a.id); expect((await request(a.id)).status).toBe(404);
});
it("backup preserves separate manual profiles without credentials or disposable fetched caches", async () => {
  const a = create(), b = create({ userId: "27" });
  await save(a.id, "https://public.example/?aff=one", 0, "https://join.example/signup");
  await save(b.id, "https://public.example/?aff=two"); await fetchCode(a.id, 1);
  const backup = store.exportBackup();
  expect(JSON.stringify(backup)).not.toContain(secret);
  expect(backup.invitations.find(value => value.accountId === a.id)).toMatchObject({ manualUrl: "https://public.example/?aff=one", registerUrl: "https://join.example/signup" });
  expect(JSON.stringify(backup.invitations)).not.toContain("Ab12");
  const restored = new Store(":memory:", Buffer.alloc(32, 9)); restored.importBackup(backup, false);
  expect(restored.invitation(a.id).manualUrl).toContain("aff=one"); expect(restored.invitation(b.id).manualUrl).toContain("aff=two");
  expect(restored.invitation(a.id).fetched).toBeNull(); expect(restored.get(a.id)?.hasCredential).toBe(false); restored.close();
  const before = store.invitation(a.id); store.importBackup(backup, true); expect(store.invitation(a.id)).toEqual(before);
  store.importBackup({ ...backup, invitations: undefined }, false); expect(store.invitation(a.id).manualUrl).toContain("aff=one"); expect(store.invitation(a.id).fetched).toBeNull();
});
it("backup invitation account references and duplicates fail before any writes", async () => {
  const a = create(), backup = store.exportBackup(), before = store.list();
  const entry = { accountId: a.id, manualUrl: "https://public.example/?aff=one", registerUrl: "", manualAt: null };
  expect(() => store.importBackup({ ...backup, invitations: [{ ...entry, accountId: "unknown" }] }, false)).toThrow();
  expect(() => store.importBackup({ ...backup, invitations: [entry, entry] }, false)).toThrow(); expect(store.list()).toEqual(before);
});
