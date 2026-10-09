import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { safeJsonRequest } from "../src/lib/outbound";
import {
  diagnosticReport,
  normalizeDiagnostic,
} from "../src/lib/query-diagnostics";

let provider: Server,
  proxy: Server,
  store: Store,
  dir: string,
  root: string,
  proxyUrl: string;
let hits = 0,
  tunnels = 0;
const sockets = new Set<Socket>();
const csrf = "c".repeat(48),
  raw = "d".repeat(64),
  key = Buffer.alloc(32, 18);
const secret = "routing-fixture-key",
  proxySecret = "routing-fixture-proxy-secret";
const saved = {
  private: process.env.RELAYDOCK_PRIVATE_HOSTS,
  dns: process.env.RELAYDOCK_DNS_MODE,
  proxy: process.env.RELAYDOCK_QUERY_PROXY_URL,
  public: process.env.RELAYDOCK_PUBLIC_URL,
};
const listen = (server: Server) =>
  new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server: Server) => (server.address() as { port: number }).port;
function call(
  path: string,
  method = "GET",
  data?: unknown,
  auth = true,
  token = csrf,
) {
  return handleApi(
    new Request("http://localhost/api/" + path, {
      method,
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        ...(auth ? { cookie: "atlas_session=" + raw } : {}),
        "x-csrf-token": token,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    path.split("/"),
    store,
  );
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-query-route-"));
  provider = createServer((req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        data: { quota: 500000 },
        authorizationCorrect: req.headers.authorization === "Bearer " + secret,
        proxyAuthorizationAbsent:
          req.headers["proxy-authorization"] === undefined,
      }),
    );
  });
  proxy = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  await listen(provider);
  root = "http://127.0.0.1:" + port(provider);
  proxy.on("connect", (req, client, head) => {
    tunnels++;
    if (
      req.url !== "127.0.0.1:" + port(provider) ||
      req.headers["proxy-authorization"] !==
        "Basic " + Buffer.from("fixture:" + proxySecret).toString("base64")
    ) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port(provider), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    for (const socket of [client as Socket, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
  });
  await listen(proxy);
  proxyUrl = `http://fixture:${proxySecret}@127.0.0.1:${port(proxy)}`;
});
beforeEach(() => {
  store = new Store(join(dir, "test.sqlite"), key);
  store.deleteSession(tokenHash(raw));
  store.createSession(tokenHash(raw), csrf);
  store.setMeta("queryRoute", "");
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
  process.env.RELAYDOCK_DNS_MODE = "system";
  delete process.env.RELAYDOCK_PUBLIC_URL;
  process.env.RELAYDOCK_QUERY_PROXY_URL = proxyUrl;
  hits = 0;
  tunnels = 0;
});
afterEach(() => store.close());
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  for (const server of [provider, proxy]) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  if (
    dirname(resolve(dir)) !== resolve(tmpdir()) ||
    !basename(dir).startsWith("atlas-query-route-")
  )
    throw new Error("Unsafe fixture cleanup path");
  rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries({
    RELAYDOCK_PRIVATE_HOSTS: saved.private,
    RELAYDOCK_DNS_MODE: saved.dns,
    RELAYDOCK_QUERY_PROXY_URL: saved.proxy,
    RELAYDOCK_PUBLIC_URL: saved.public,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
it("reports the existing deployment default without probing or exposing proxy authentication", async () => {
  const r = await call("query/routing");
  expect(r.status).toBe(200);
  const data = await r.json();
  expect(data).toEqual({
    mode: "proxy",
    proxyConfigured: true,
    proxyValid: true,
  });
  expect(JSON.stringify(data)).not.toContain(proxySecret);
  expect(JSON.stringify(data)).not.toContain("127.0.0.1");
  expect(hits).toBe(0);
  expect(tunnels).toBe(0);
});
it("defaults to direct on an unconfigured deployment and refuses unavailable proxy selection", async () => {
  delete process.env.RELAYDOCK_QUERY_PROXY_URL;
  expect(await (await call("query/routing")).json()).toEqual({
    mode: "direct",
    proxyConfigured: false,
    proxyValid: false,
  });
  const r = await call("query/routing", "POST", { mode: "proxy" });
  expect(r.status).toBe(400);
  expect(hits).toBe(0);
  expect(tunnels).toBe(0);
});
it("requires login and CSRF for saving, rejects arbitrary URLs/modes, and never queries on toggle", async () => {
  expect((await call("query/routing", "GET", undefined, false)).status).toBe(
    401,
  );
  expect(
    (await call("query/routing", "POST", { mode: "direct" }, false)).status,
  ).toBe(401);
  expect(
    (await call("query/routing", "POST", { mode: "direct" }, true, "bad"))
      .status,
  ).toBe(403);
  expect((await call("query/routing", "POST", { mode: "auto" })).status).toBe(
    400,
  );
  expect(
    (await call("query/routing", "POST", { mode: "proxy", proxyUrl })).status,
  ).toBe(400);
  expect((await call("query/routing", "POST", { mode: "direct" })).status).toBe(
    200,
  );
  expect(hits).toBe(0);
  expect(tunnels).toBe(0);
  expect(process.env.RELAYDOCK_QUERY_PROXY_URL).toBe(proxyUrl);
});
it("persists an explicit selection across restart, not backups, without mutating deployment env", async () => {
  await call("query/routing", "POST", { mode: "direct" });
  store.close();
  store = new Store(join(dir, "test.sqlite"), key);
  expect((await (await call("query/routing")).json()).mode).toBe("direct");
  const backup = store.exportBackup();
  expect(JSON.stringify(backup)).not.toContain("queryRoute");
  expect(JSON.stringify(backup)).not.toContain(proxySecret);
  store.setMeta("queryRoute", "proxy");
  store.importBackup(backup, false);
  expect((await (await call("query/routing")).json()).mode).toBe("proxy");
  expect(process.env.RELAYDOCK_QUERY_PROXY_URL).toBe(proxyUrl);
});
it("keeps an explicit proxy selection fail-closed if deployment configuration disappears", async () => {
  store.setMeta("queryRoute", "proxy");
  delete process.env.RELAYDOCK_QUERY_PROXY_URL;
  expect((await (await call("query/routing")).json()).mode).toBe("proxy");
  const error = await safeJsonRequest(root, secret, "", {
    routeMode: "proxy",
  }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "proxy_config" });
  expect(hits).toBe(0);
});
it("chooses direct and proxy independently per request without a global env mutation", async () => {
  const before = process.env.RELAYDOCK_QUERY_PROXY_URL;
  await expect(
    safeJsonRequest(root, secret, "", { routeMode: "direct" }),
  ).resolves.toMatchObject({
    authorizationCorrect: true,
    proxyAuthorizationAbsent: true,
  });
  expect(tunnels).toBe(0);
  await expect(
    safeJsonRequest(root, secret, "", { routeMode: "proxy" }),
  ).resolves.toMatchObject({
    authorizationCorrect: true,
    proxyAuthorizationAbsent: true,
  });
  expect(hits).toBe(2);
  expect(tunnels).toBe(1);
  expect(process.env.RELAYDOCK_QUERY_PROXY_URL).toBe(before);
});
it("an explicit direct query bypasses a malformed proxy without changing the configured value", async () => {
  process.env.RELAYDOCK_QUERY_PROXY_URL =
    "http://fixture:" + proxySecret + "@127.0.0.1/path";
  await expect(
    safeJsonRequest(root, secret, "", { routeMode: "direct" }),
  ).resolves.toMatchObject({ success: true });
  expect(tunnels).toBe(0);
  const r = await call("query/routing", "POST", { mode: "proxy" });
  expect(r.status).toBe(400);
  expect(JSON.stringify(await r.json())).not.toContain(proxySecret);
});
it("uses a captured query mode for sync and draft tests, and records the actual route", async () => {
  await call("query/routing", "POST", { mode: "direct" });
  const a = store.create({
    name: "routing fixture",
    siteUrl: root,
    managementUrl: root,
    provider: "newapi",
    userId: "123",
    quotaPerUnit: "500000",
    unit: "USD",
    credential: secret,
    initialBalance: "5",
  });
  const r = await call(`accounts/${a.id}/sync`, "POST", { routeMode: "proxy" });
  expect(r.status).toBe(200);
  expect(tunnels).toBe(1);
  expect(store.get(a.id)?.lastSyncDiagnostic).toMatchObject({
    routeMode: "proxy",
    code: "ok",
  });
  const before = store.history(a.id).length;
  await call("query/routing", "POST", { mode: "proxy" });
  const draft = await call("query/test", "POST", {
    provider: "newapi",
    siteUrl: root,
    managementUrl: root,
    userId: "123",
    quotaPerUnit: "500000",
    unit: "USD",
    credential: secret,
    routeMode: "direct",
  });
  expect(draft.status).toBe(200);
  expect((await draft.json()).diagnostic.routeMode).toBe("direct");
  expect(tunnels).toBe(1);
  expect(store.history(a.id)).toHaveLength(before);
});
it("concurrent opposite routes cannot contaminate each other", async () => {
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      safeJsonRequest(root, secret, "", {
        routeMode: i % 2 ? "proxy" : "direct",
      }),
    ),
  );
  expect(hits).toBe(6);
  expect(tunnels).toBe(3);
  expect(process.env.RELAYDOCK_QUERY_PROXY_URL).toBe(proxyUrl);
});
it("accepts a legacy empty POST stream using the saved route but rejects malformed nonempty JSON", async () => {
  store.setMeta("queryRoute", "direct");
  const a = store.create({
    name: "empty POST fixture",
    siteUrl: root,
    provider: "newapi",
    credential: secret,
  });
  for (const operation of ["test", "sync"] as const) {
    const path = `accounts/${a.id}/${operation}`;
    // An empty string creates a real, zero-byte body stream, like Next/HTTP POST.
    const request = new Request("http://localhost/api/" + path, {
      method: "POST",
      body: "",
      headers: {
        origin: "http://localhost",
        cookie: "atlas_session=" + raw,
        "x-csrf-token": csrf,
      },
    });
    expect(request.body).not.toBeNull();
    const r = await handleApi(request, path.split("/"), store);
    expect(r.status).toBe(200);
  }
  expect(hits).toBe(2);
  expect(tunnels).toBe(0);
  const path = `accounts/${a.id}/sync`;
  const invalid = await handleApi(
    new Request("http://localhost/api/" + path, {
      method: "POST",
      body: " ",
      headers: {
        origin: "http://localhost",
        cookie: "atlas_session=" + raw,
        "x-csrf-token": csrf,
      },
    }),
    path.split("/"),
    store,
  );
  expect(invalid.status).toBe(400);
  expect(hits).toBe(2);
});
it("uses the stored default without a request override and preserves balance on unavailable proxy", async () => {
  const a = store.create({
    name: "route fallback fixture",
    siteUrl: root,
    provider: "newapi",
    credential: secret,
    userId: "123",
    unit: "USD",
    quotaPerUnit: "500000",
    initialBalance: "7",
  });
  await call("query/routing", "POST", { mode: "direct" });
  expect((await call(`accounts/${a.id}/test`, "POST")).status).toBe(200);
  expect(store.get(a.id)?.lastQueryDiagnostic?.routeMode).toBe("direct");
  expect(tunnels).toBe(0);
  store.setMeta("queryRoute", "proxy");
  delete process.env.RELAYDOCK_QUERY_PROXY_URL;
  const before = store.history(a.id);
  const r = await call(`accounts/${a.id}/sync`, "POST");
  expect(r.status).toBe(502);
  expect(store.get(a.id)).toMatchObject({
    balance: "7",
    lastSyncDiagnostic: { code: "proxy_config", routeMode: "proxy" },
  });
  expect(store.history(a.id)).toEqual(before);
  expect(hits).toBe(1);
  expect(tunnels).toBe(0);
});
it("rejects invalid captured routes and extra proxy fields before any provider request", async () => {
  const a = store.create({
    name: "bad route fixture",
    siteUrl: root,
    provider: "newapi",
    credential: secret,
  });
  for (const payload of [
    { routeMode: "auto" },
    { routeMode: "direct", proxyUrl },
  ])
    expect((await call(`accounts/${a.id}/sync`, "POST", payload)).status).toBe(
      400,
    );
  const error = await safeJsonRequest(root, secret, "", {
    routeMode: "auto" as "direct",
  }).catch((e) => e);
  expect(error).toMatchObject({ code: "invalid_config" });
  expect(hits).toBe(0);
  expect(tunnels).toBe(0);
});
it("whitelists route diagnostics without leaking proxy details or inventing an old report route", async () => {
  const draft = await call("query/test", "POST", {
    provider: "newapi",
    siteUrl: root,
    credential: secret,
    routeMode: "proxy",
  });
  const { diagnostic } = await draft.json();
  expect(draft.status).toBe(200);
  const report = diagnosticReport({ ...diagnostic, proxyUrl, proxySecret });
  expect(JSON.parse(report).routeMode).toBe("proxy");
  expect(report).not.toContain(proxySecret);
  expect(report).not.toContain("127.0.0.1");
  const { routeMode: _routeMode, ...old } = diagnostic;
  expect(normalizeDiagnostic(old)).toMatchObject({ code: "ok" });
  expect(normalizeDiagnostic(old)).not.toHaveProperty("routeMode");
  expect(normalizeDiagnostic({ ...old, routeMode: proxyUrl })).toBeNull();
  const publicAccounts = await (await call("accounts")).json();
  expect(publicAccounts.queryRouting).toEqual({
    mode: "proxy",
    proxyConfigured: true,
    proxyValid: true,
  });
  expect(JSON.stringify(publicAccounts)).not.toContain(proxySecret);
});
