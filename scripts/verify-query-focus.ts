import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { chromium, type Browser, type Page, type Locator } from "playwright";
import { Store } from "../src/lib/store"; // Class only: NEVER call getStore().
import { hashPassword } from "../src/lib/crypto";
import type { Account, Snapshot } from "../src/lib/validation";
import { verifyWorkspaceFrames } from "./verify-workspace-frames";
import { verifyAppearance } from "./verify-appearance-aff";
import type { GroupLayout } from "../src/lib/group-layout";
import { cleanRuntimeEnv } from "./isolated-runtime";
import {
  boundedLog,
  buildIsolatedSource,
  cleanupIsolatedSource,
  createIsolatedSource,
  stopOwnedChild,
  type IsolatedSource,
} from "./build-source-isolated";

// PREPARE FIRST. The parent must explicitly announce ready before running:
// npx --no-install tsx scripts/verify-query-focus.ts --ready
// Without --ready this exits WAITING_READY without creating/building/starting anything.
// New production build only; random loopback ports; generated SQLite; no real providers.
// No .env*, repository data/vault, old .next, npm install, port kills, Git writes or trace.
const required = [
  "fresh-isolated-production-build",
  "workspace-map-detail-frame-alignment",
  "saved-group-create-callback-focus",
  "selected-within-group-focus-after-success",
  "selected-cross-group-focus-after-success",
  "other-within-group-focus-after-success",
  "other-cross-group-focus-after-success",
  "failed-selected-move-rolls-back-without-focus",
  "failed-other-move-keeps-selection-camera",
  "whole-island-move-keeps-camera",
  "ordinary-balance-write-keeps-camera",
  "map-title-rename-archived-filter-fold-position",
  "list-global-rename-archived-only",
  "duplicate-rename-rejected-ui-and-api",
  "editor-atlas-cc-switch-gzip-diagnostic",
  "delayed-delete-load-get-cannot-remove-new-saved-focus",
  "delayed-delete-load-get-cannot-undo-rename-selection",
  "wizard-atlas-cc-switch-gzip-test-no-persistence",
  "same-domain-two-accounts-isolated",
  ...[375, 768, 1440].flatMap((w) =>
    ["light", "dark"].map((t) => `viewport-${w}-${t}`),
  ),
  "idle-navigation-route-switch-no-query",
  "browser-fixture-errors-and-query-counts",
  "negative-world-reload-overview-and-hand-pan",
  "appearance-persistence-ink-backgrounds-and-geometric-loading",
];
const password = "fixture-query-focus-password-only";
const identities = {
  alpha: {
    key: "fixture-qf-management-alpha",
    userId: "700101",
    quota: 1_250_000,
    initial: "7.25",
  },
  beta: {
    key: "fixture-qf-management-beta",
    userId: "700202",
    quota: 4_250_000,
    initial: "19.5",
  },
} as const;
const proxySecret = "fixture-query-focus-proxy-only";
type Identity = keyof typeof identities;
type Profile = "atlas" | "cc-switch";
type State = {
  accounts: Account[];
  snapshots: Snapshot[];
  groupLayout: GroupLayout;
};
type Owner = { pid: number; name: string; startedAt: string };
const pause = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const redact = (value: string) =>
  [
    password,
    proxySecret,
    ...Object.values(identities).flatMap((v) => [v.key, v.userId]),
  ].reduce((s, secret) => s.split(secret).join("[FIXTURE REDACTED]"), value);
const message = (e: unknown) =>
  redact(e instanceof Error ? e.message : String(e));
let cancellation: AbortSignal | undefined;
async function until(
  test: () => boolean | Promise<boolean>,
  label: string,
  ms = 8000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cancellation?.aborted) throw cancellation.reason;
    if (await test()) return;
    await pause(40);
  }
  assert.fail(label);
}
async function deadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function owners3000(): Promise<Owner[]> {
  assert.equal(
    process.platform,
    "win32",
    "3000 owner protection currently requires Windows",
  );
  const code =
    "$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | " +
    "Where-Object LocalPort -eq 3000 | Select-Object -ExpandProperty OwningProcess -Unique); " +
    "$result=@($ids | Sort-Object | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction Stop; " +
    "[pscustomobject]@{pid=$p.Id;name=$p.ProcessName;startedAt=$p.StartTime.ToUniversalTime().ToString('o')} }); " +
    "ConvertTo-Json -InputObject $result -Compress";
  // Do not read process command lines/environment, which might contain secrets.
  const text = await new Promise<string>((ok, fail) =>
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", code],
      {
        windowsHide: true,
        env: cleanRuntimeEnv(),
        timeout: 20_000,
        maxBuffer: 8192,
      },
      (e, stdout) => (e ? fail(e) : ok(stdout)),
    ),
  );
  return JSON.parse(text.trim()) as Owner[];
}
function repositoryBuildStamp(root: string) {
  // Metadata only, never reading/copying/using the existing build contents.
  return [".next", ".next/BUILD_ID"].map((name) => {
    const path = join(root, name);
    if (!existsSync(path)) return { name, exists: false };
    const stat = lstatSync(path);
    return { name, exists: true, size: stat.size, modified: stat.mtimeMs };
  });
}
function credentialDigests(owned: IsolatedSource) {
  const dbPath = realpathSync(join(owned.dataDir, "atlas.sqlite"));
  assert.equal(dirname(dbPath), realpathSync(owned.dataDir));
  assert.equal(dirname(realpathSync(owned.dataDir)), owned.temp);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      (
        db.prepare("SELECT id,secret FROM accounts ORDER BY id").all() as {
          id: string;
          secret: string | null;
        }[]
      ).map((r) => [r.id, r.secret === null ? null : sha(r.secret)]),
    );
  } finally {
    db.close();
  }
}
function stableBalances(a: Account) {
  return {
    id: a.id,
    balance: a.balance,
    unit: a.balanceUnit,
    rawQuota: a.rawQuota,
    snapshot: a.balanceSnapshotId,
    lastSnapshotAt: a.lastSnapshotAt,
    hasCredential: a.hasCredential,
  };
}
function preserveRecords(before: State, after: State) {
  assert.deepEqual(
    after.snapshots,
    before.snapshots,
    "Movement/rename/test must not write history",
  );
  assert.deepEqual(
    after.accounts.map(stableBalances).sort((a, b) => a.id.localeCompare(b.id)),
    before.accounts
      .map(stableBalances)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
function diagnostic(
  value: unknown,
  profile: Profile,
  sample: { wire: number; decoded: number; status: number },
  outcome = "success",
) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const d = value as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(d).sort(),
    [
      "schemaVersion",
      "provider",
      "operation",
      "startedAt",
      "finishedAt",
      "totalMs",
      "timeoutSeconds",
      "dnsMode",
      "routeMode",
      "requestProfile",
      ...(sample.status === 200 ? ["response"] : []),
      "outcome",
      "category",
      "code",
      "httpStatus",
      "stages",
    ].sort(),
    "Diagnostic top-level whitelist",
  );
  assert.equal(d.provider, "newapi");
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.requestProfile, profile);
  assert.equal(d.dnsMode, "system");
  assert.ok(["direct", "proxy"].includes(String(d.routeMode)));
  assert.equal(d.outcome, outcome);
  assert.equal(d.code, outcome === "success" ? "ok" : "http_auth");
  assert.equal(d.httpStatus, sample.status);
  if (sample.status === 200) {
    const r = d.response as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(r).sort(),
      ["mediaType", "encoding", "bodyKind", "wireBytes", "decodedBytes"].sort(),
    );
    assert.equal(r.mediaType, "json");
    assert.equal(r.encoding, "gzip");
    assert.equal(r.bodyKind, "json");
    assert.equal(r.wireBytes, sample.wire);
    assert.equal(r.decodedBytes, sample.decoded);
  } else {
    assert.ok(
      [401, 403].includes(sample.status),
      "Only this fixture's auth failure skips body parsing",
    );
    assert.equal(d.category, "auth");
    assert.ok(
      !("response" in d),
      "Do not fabricate features for an unread non-200 body",
    );
    const stages = d.stages as { id: string; status: string }[];
    for (const id of ["read", "parse"])
      assert.equal(stages.find((s) => s.id === id)?.status, "not-run");
  }
  assert.ok(Array.isArray(d.stages));
  for (const s of d.stages)
    assert.deepEqual(
      Object.keys(s).sort(),
      ["id", "status", "durationMs"].sort(),
    );
  const serialized = JSON.stringify(d);
  for (const forbidden of [
    password,
    proxySecret,
    "127.0.0.1",
    "fixture.invalid",
    "PRIVATE-FIXTURE-BODY",
    ...Object.values(identities).flatMap((i) => [i.key, i.userId]),
    '"headers"',
    '"body"',
    '"quota"',
    '"url"',
  ])
    assert.ok(
      !serialized.includes(forbidden),
      "Diagnostic leaked fixture identity/headers/body",
    );
  return d;
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.every((arg) => ["--ready", "--help"].includes(arg)),
    "Only --ready/--help are accepted",
  );
  if (!args.includes("--ready") || args.includes("--help")) {
    console.log(
      JSON.stringify({
        status: "WAITING_READY",
        buildStarted: false,
        serviceStarted: false,
        commandAfterParentReady:
          "npx --no-install tsx scripts/verify-query-focus.ts --ready",
        checks: required,
      }),
    );
    return;
  }
  const root = realpathSync(resolve(process.cwd()));
  assert.equal(
    basename(root).toLowerCase(),
    "relaydock",
    "Run from the relaydock directory",
  );
  const out = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "relaydock-query-focus-report-")),
  );
  const buildLog = boundedLog(),
    serverLog = boundedLog(16 * 1024);
  const checks: {
    name: string;
    status: "PASS" | "FAIL";
    ms: number;
    evidence?: unknown;
    error?: string;
  }[] = [];
  const errors: string[] = [],
    fixtureErrors: string[] = [],
    cleanupErrors: string[] = [],
    expectedHttpErrors: { path: string; status: number }[] = [],
    screenshots: string[] = [];
  const sockets = new Set<Duplex>();
  const counts = {
    provider: 0,
    proxyConnect: 0,
    draftTests: 0,
    savedTests: 0,
    syncs: 0,
    creates: 0,
    deletes: 0,
    moves: 0,
    groupMoves: 0,
    renames: 0,
    routingWrites: 0,
  };
  const observed: {
    identity: Identity;
    profile: Profile;
    authValid: boolean;
    userIdValid: boolean;
    status: number;
    wire: number;
    decoded: number;
  }[] = [];
  let owned: IsolatedSource | undefined,
    browser: Browser | undefined,
    page: Page | undefined,
    child: ReturnType<typeof spawn> | undefined,
    build: Awaited<ReturnType<typeof buildIsolatedSource>> | undefined;
  let ownersBefore: Owner[] = [],
    ownersAfter: Owner[] = [],
    buildBefore: ReturnType<typeof repositoryBuildStamp> = [],
    buildAfter: ReturnType<typeof repositoryBuildStamp> = [],
    failure: unknown,
    port = 0,
    providerPort = 0,
    proxyPort = 0,
    phase = "preflight",
    failIdentity: Identity | null = null,
    childStopped = false,
    tempRemoved = false;
  const abort = new AbortController();
  cancellation = abort.signal;
  const gates = new Set<() => void>();
  abort.signal.addEventListener(
    "abort",
    () => {
      for (const release of gates) release();
      void browser?.close().catch(() => {});
      void stopOwnedChild(child).catch(() => {});
    },
    { once: true },
  );
  const interrupt = () => abort.abort(new Error("Acceptance interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(
    () => abort.abort(new Error("Acceptance exceeded 7 minutes")),
    420_000,
  );
  const check = async (name: string, work: () => Promise<unknown>) => {
    phase = name;
    console.log(JSON.stringify({ check: name, status: "RUNNING" }));
    const start = Date.now();
    try {
      assert.ok(!abort.signal.aborted);
      const evidence = await work();
      checks.push({ name, status: "PASS", ms: Date.now() - start, evidence });
      console.log(JSON.stringify({ check: name, status: "PASS" }));
    } catch (e) {
      console.log(
        JSON.stringify({ check: name, status: "FAIL", error: message(e) }),
      );
      checks.push({
        name,
        status: "FAIL",
        ms: Date.now() - start,
        error: message(e),
      });
      throw e;
    }
  };
  const listen = (server: Server) =>
    new Promise<number>((ok, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () =>
        ok((server.address() as { port: number }).port),
      );
    });
  const provider = createServer((req, res) => {
    counts.provider++;
    const identity = (Object.keys(identities) as Identity[]).find(
      (i) => req.headers.authorization === "Bearer " + identities[i].key,
    );
    const profile =
      req.headers["user-agent"] === "cc-switch/1.0" ? "cc-switch" : "atlas";
    const valid =
      !!identity &&
      req.headers["new-api-user"] === identities[identity].userId &&
      req.method === "GET" &&
      req.url === "/api/user/self" &&
      !req.headers.cookie &&
      !req.headers["proxy-authorization"] &&
      req.headers.accept ===
        (profile === "atlas" ? "application/json" : "*/*") &&
      req.headers["user-agent"] ===
        (profile === "atlas" ? "RelayDock-Atlas/1.0" : "cc-switch/1.0") &&
      req.headers["accept-encoding"] === "gzip, deflate, br";
    if (!valid)
      fixtureErrors.push(
        "Provider rejected wrong management key/userID/profile/path or leaked cookie/proxy auth",
      );
    const status = valid && identity !== failIdentity ? 200 : 401;
    const raw = Buffer.from(
      JSON.stringify({
        success: status === 200,
        data: {
          quota: identity ? identities[identity].quota : 0,
          used_quota: 500000,
        },
        privateFixture: {
          marker: "PRIVATE-FIXTURE-BODY",
          key: identity ? identities[identity].key : "invalid",
          userId: identity ? identities[identity].userId : "invalid",
          domain: "fixture.invalid",
        },
      }),
    );
    const body = gzipSync(raw);
    if (identity)
      observed.push({
        identity,
        profile,
        authValid: true,
        userIdValid:
          req.headers["new-api-user"] === identities[identity].userId,
        status,
        wire: body.length,
        decoded: raw.length,
      });
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Length": body.length,
    });
    res.end(body);
  });
  const proxy = createServer((_req, res) => {
    fixtureErrors.push("Proxy must only receive CONNECT");
    res.writeHead(405);
    res.end();
  });
  proxy.on("connect", (req, client, head) => {
    counts.proxyConnect++;
    if (
      req.url !== `127.0.0.1:${providerPort}` ||
      req.headers.authorization ||
      req.headers["proxy-authorization"] !==
        "Basic " + Buffer.from("fixture:" + proxySecret).toString("base64")
    ) {
      fixtureErrors.push("Proxy identity/target separation failed");
      client.destroy();
      return;
    }
    const upstream = connect(providerPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("close", () => upstream.destroy());
  });
  const run = async () => {
    ownersBefore = await owners3000();
    buildBefore = repositoryBuildStamp(root);
    await check("fresh-isolated-production-build", async () => {
      owned = createIsolatedSource(root);
      build = await buildIsolatedSource(
        owned,
        cleanRuntimeEnv(),
        buildLog,
        abort.signal,
      );
      return {
        ...build,
        sourceFingerprint: owned.sourceFingerprint,
        copiedFiles: owned.copiedFiles,
        copiedBytes: owned.copiedBytes,
        reusedRepositoryBuild: false,
      };
    });
    const runtime = owned!;
    providerPort = await listen(provider);
    proxyPort = await listen(proxy);
    const probe = createServer();
    port = await listen(probe);
    await new Promise<void>((ok, fail) =>
      probe.close((e) => (e ? fail(e) : ok())),
    );
    assert.notEqual(port, 3000);
    const origin = `http://127.0.0.1:${port}`,
      site = `http://127.0.0.1:${providerPort}`,
      fixtureKey = randomBytes(32),
      fixtures: Account[] = [];
    const store = new Store(join(runtime.dataDir, "atlas.sqlite"), fixtureKey);
    let alpha!: Account, beta!: Account;
    try {
      store.setMeta("adminHash", hashPassword(password));
      store.setMeta("queryRoute", "direct");
      store.setSettings({
        theme: "light",
        motion: false,
        mapBackground: "dots",
      });
      for (let i = 0; i < 8; i++)
        fixtures.push(
          store.create({
            name: `手动夹具 ${i + 1}`,
            siteUrl: site,
            group: i < 4 ? "保存分组" : "备用分组",
            initialBalance: String(10 + i),
            unit: "USD",
          }),
        );
      fixtures.push(
        store.create({
          name: "组内归档夹具",
          siteUrl: site,
          group: "保存分组",
          archived: true,
          initialBalance: "23",
        }),
      );
      fixtures.push(
        store.create({
          name: "独立归档夹具",
          siteUrl: site,
          group: "仅归档分组",
          archived: true,
          initialBalance: "31",
        }),
      );
      const addIdentity = (id: Identity) =>
        store.create({
          name: "同站点 NewAPI",
          alias: id,
          siteUrl: site,
          apiUrl: site,
          managementUrl: site,
          group: "查询账号",
          provider: "newapi",
          credential: identities[id].key,
          userId: identities[id].userId,
          unit: "USD",
          quotaPerUnit: "500000",
          initialBalance: identities[id].initial,
          query: { requestProfile: "atlas" },
        });
      alpha = addIdentity("alpha");
      beta = addIdentity("beta");
      assert.notEqual(alpha.id, beta.id);
      assert.equal(store.credential(alpha.id), identities.alpha.key);
      assert.equal(store.credential(beta.id), identities.beta.key);
    } finally {
      store.close();
    }
    child = spawn(
      process.execPath,
      [
        join(runtime.depsTarget, "next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: runtime.runtime,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...cleanRuntimeEnv(),
          NEXT_TELEMETRY_DISABLED: "1",
          RELAYDOCK_DATA_DIR: runtime.dataDir,
          RELAYDOCK_VAULT_KEY: fixtureKey.toString("hex"),
          RELAYDOCK_PUBLIC_URL: origin,
          RELAYDOCK_DNS_MODE: "system",
          RELAYDOCK_PRIVATE_HOSTS: "127.0.0.1",
          RELAYDOCK_QUERY_PROXY_URL: `http://fixture:${proxySecret}@127.0.0.1:${proxyPort}`,
        },
      },
    );
    child.stdout!.on("data", (b: Buffer) => serverLog.add(b));
    child.stderr!.on("data", (b: Buffer) => serverLog.add(b));
    child.on("error", (e) => abort.abort(e));
    await until(
      async () => {
        assert.equal(child!.exitCode, null, "Owned production server exited");
        try {
          return (
            await fetch(origin + "/api/auth/session", {
              signal: AbortSignal.timeout(1500),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      "New production server did not become ready",
      30_000,
    );
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    assert.ok(!abort.signal.aborted, "Browser launch canceled");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:"].includes(url.protocol))
        await route.continue();
      else {
        errors.push("Blocked non-fixture browser request");
        await route.abort("blockedbyclient");
      }
    });
    page = await context.newPage();
    const view = page;
    // Handle rejection immediately: a prior click/assertion may fail first.
    // Keep awaiting the original promise so the report retains the real error.
    const intercept: Page["route"] = (pattern, handler, options) =>
      view.route(
        pattern,
        async (route, request) => {
          try {
            await handler(route, request);
          } catch (error) {
            // Cleanup may close a held route. Never let a sidecar callback crash
            // the process before the primary assertion/report/finally completes.
            if (!abort.signal.aborted)
              errors.push("Fixture route: " + message(error));
            await route.abort("failed").catch(() => {});
          }
        },
        options,
      );
    const waitResponse: Page["waitForResponse"] = (...args) => {
      const waiting = view.waitForResponse(...args);
      void waiting.catch(() => {});
      return waiting;
    };
    view.setDefaultTimeout(8000);
    const expected = new Map<string, Set<number>>();
    const allowHttp = (path: string, status: number) => {
      expected.set(path, new Set([...(expected.get(path) || []), status]));
    };
    view.on("pageerror", (e) => errors.push(message(e)));
    view.on("console", (entry) => {
      if (entry.type() !== "error") return;
      const url = entry.location().url;
      const path = url.startsWith(origin) ? new URL(url).pathname : "";
      if (expected.has(path) && /Failed to load resource/.test(entry.text()))
        return;
      errors.push("console: " + redact(entry.text()));
    });
    view.on("response", (r) => {
      if (r.status() < 400) return;
      const path = new URL(r.url()).pathname;
      if (expected.get(path)?.has(r.status()))
        expectedHttpErrors.push({ path, status: r.status() });
      else errors.push(`Unexpected browser HTTP ${r.status()} ${path}`);
    });
    view.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() === "DELETE" && /^\/api\/accounts\/[^/]+$/.test(path))
        counts.deletes++;
      if (r.method() !== "POST") return;
      if (path === "/api/query/test") counts.draftTests++;
      if (/\/api\/accounts\/[^/]+\/test$/.test(path)) counts.savedTests++;
      if (/\/api\/accounts\/[^/]+\/sync$/.test(path)) counts.syncs++;
      if (path === "/api/accounts") counts.creates++;
      if (path === "/api/accounts/move") counts.moves++;
      if (path === "/api/map/groups/move") counts.groupMoves++;
      if (path === "/api/map/groups/rename") counts.renames++;
      if (path === "/api/query/routing") counts.routingWrites++;
    });
    const api = async (
      path: string,
      method = "GET",
      data?: unknown,
      status = 200,
    ) => {
      assert.ok(
        !/\/(?:sync|test)$/.test(path),
        "Provider queries must be explicit browser clicks",
      );
      const session = await (
        await context.request.get(origin + "/api/auth/session")
      ).json();
      const res = await context.request.fetch(origin + "/api/" + path, {
        method,
        data,
        headers: { origin, "x-csrf-token": session.csrf },
      });
      assert.equal(res.status(), status, "Fixture API: " + path);
      return res.json();
    };
    const state = async (): Promise<State> => {
      const [list, history] = await Promise.all([
        api("accounts"),
        api("history"),
      ]);
      return {
        accounts: list.accounts,
        groupLayout: list.groupLayout,
        snapshots: history.snapshots,
      };
    };
    const account = async (id: string) =>
      (await state()).accounts.find((a) => a.id === id)!;
    const dialog = () => view.getByRole("dialog");
    const select = async (
      label: string,
      option: string | RegExp,
      scope?: Locator,
    ) => {
      const button = (scope || view).getByRole("combobox", {
        name: label,
        exact: true,
      });
      assert.equal(
        await button.evaluate((e) => e.tagName),
        "BUTTON",
        label + " must use AtlasSelect",
      );
      await button.click();
      // The accessible name also contains the option description/count. Match
      // the visible primary label exactly instead of discarding that helpful copy.
      const name =
        typeof option === "string"
          ? new RegExp(
              "^" + option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
            )
          : option;
      await view
        .getByRole("option")
        .filter({
          has: view.locator(".atlas-select-label").filter({ hasText: name }),
        })
        .click();
    };
    const openGlobalGroupRename = async () => {
      const button = view.getByRole("button", { name: "分组改名", exact: true });
      if (!(await button.isVisible())) await view.getByLabel("更多筛选", { exact: true }).click();
      await button.click();
    };
    const world = () => view.getByTestId("map-world").getAttribute("transform");
    const settledCamera = async () => {
      let previous: string | null = null,
        stable = 0;
      await until(
        async () => {
          const current = await world();
          const active = await view
            .getByTestId("atlas-map")
            .getAttribute("data-panning");
          stable = current === previous && active !== "true" ? stable + 1 : 0;
          previous = current;
          return stable >= 2;
        },
        "Explicit camera instruction must finish before movement assertions",
        1800,
      );
      return previous;
    };
    const node = (id: string) => view.locator(`[data-account-id="${id}"]`);
    const selectedId = () =>
      view
        .locator('[data-account-id][aria-pressed="true"]')
        .getAttribute("data-account-id");
    const camera = () =>
      view.getByTestId("map-world").evaluate((e) => {
        const m = (e as unknown as SVGGraphicsElement).getScreenCTM()!;
        return { k: m.a, x: m.e, y: m.f };
      });
    const centered = async (id: string) =>
      view.evaluate((id) => {
        const e = document.querySelector(
          `[data-account-id="${id}"]`,
        ) as SVGGraphicsElement | null;
        const svg = document.querySelector(".atlas-svg");
        if (!e || !svg) return { distance: Infinity, selected: false };
        const m = e.getScreenCTM(),
          box = svg.getBoundingClientRect();
        if (!m) return { distance: Infinity, selected: false };
        return {
          distance: Math.hypot(
            m.e - box.x - box.width / 2,
            m.f - box.y - box.height / 2,
          ),
          selected: e.getAttribute("aria-pressed") === "true",
        };
      }, id);
    const focus = async (id: string) => {
      await until(
        async () => {
          const c = await centered(id);
          return c.selected && c.distance < 3;
        },
        "Successful callback must immediately select and center the committed target",
        1800,
      );
      const c = await camera();
      assert.ok(c.k >= 0.81 && c.k <= 1.26, "Node focus, not a whole-map fit");
      return { id, ...(await centered(id)), camera: c };
    };
    const positions = () =>
      view.locator("[data-account-id]").evaluateAll((es) =>
        es
          .map((e) => ({
            id: e.getAttribute("data-account-id"),
            transform: e.getAttribute("transform"),
          }))
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      );
    const islands = () =>
      view.locator("[data-island-group]").evaluateAll((es) =>
        es
          .map((e) => {
            const ellipse = e.querySelector("ellipse")!;
            return {
              name: e.getAttribute("data-island-group"),
              cx: ellipse.getAttribute("cx"),
              cy: ellipse.getAttribute("cy"),
              rx: ellipse.getAttribute("rx"),
              ry: ellipse.getAttribute("ry"),
            };
          })
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      );
    const noQueries = async (work: () => Promise<unknown>) => {
      const before = {
        provider: counts.provider,
        proxy: counts.proxyConnect,
        draft: counts.draftTests,
        test: counts.savedTests,
        sync: counts.syncs,
      };
      await work();
      await pause(250);
      assert.deepEqual(
        {
          provider: counts.provider,
          proxy: counts.proxyConnect,
          draft: counts.draftTests,
          test: counts.savedTests,
          sync: counts.syncs,
        },
        before,
        "No query without an explicit query click",
      );
    };
    const clickNode = async (id: string) => {
      // Keyboard selection is a supported, real UI interaction, including offscreen SVG nodes.
      await node(id).focus();
      await view.keyboard.press("Enter");
      await focus(id);
    };
    const screenshot = async (name: string) => {
      await view.screenshot({ path: join(out, name), fullPage: false });
      screenshots.push(name);
    };
    await view.goto(origin);
    await view.getByLabel("管理员密码").fill(password);
    await view
      .getByRole("button", { name: "进入我的群岛", exact: true })
      .click();
    await view.getByTestId("atlas-map").waitFor();
    await node(fixtures[0].id).waitFor();
    await until(
      async () => !(await view.getByTestId("query-route-direct").isDisabled()),
      "Routing status ready",
    );
    assert.equal(counts.provider, 0);

    await check("workspace-map-detail-frame-alignment", async () => {
      await noQueries(async () => {
        await node(alpha.id).focus(); await node(alpha.id).press("Enter"); await focus(alpha.id);
        await view.locator(".account-detail").waitFor();
        const frames = await verifyWorkspaceFrames(view, out); screenshots.push(...frames.screenshots);
        await view.getByRole("button", { name: "关闭账号详情", exact: true }).click();
      });
    });

    let added!: Account;
    await check("saved-group-create-callback-focus", async () => {
      await noQueries(async () => {
        await view
          .getByRole("button", { name: "折叠分组 保存分组", exact: true })
          .and(view.locator(".island-header-action"))
          .click();
        await select("筛选分组", "备用分组");
        await view
          .getByLabel("搜索站点", { exact: true })
          .fill("不会匹配新增夹具");
        await view
          .getByRole("button", { name: "添加站点", exact: true })
          .click();
        await dialog()
          .getByRole("button", { name: "下一步", exact: true })
          .click();
        await dialog()
          .getByLabel(/^站点名称/)
          .fill("保存回调焦点夹具");
        await dialog()
          .getByLabel(/^网站地址/)
          .fill(site);
        await dialog()
          .getByRole("button", { name: "下一步", exact: true })
          .click();
        await dialog()
          .getByRole("button", { name: "继续确认单位", exact: true })
          .click();
        await dialog()
          .getByLabel("我已确认余额单位与查询口径", { exact: true })
          .check();
        await dialog()
          .getByRole("button", { name: "下一步", exact: true })
          .click();
        await dialog()
          .getByRole("combobox", { name: "分组", exact: true })
          .click();
        for (const name of ["保存分组", "备用分组", "仅归档分组", "未分组"])
          assert.equal(
            await view.getByRole("option", { name, exact: true }).count(),
            1,
          );
        await view
          .getByRole("option", { name: "保存分组", exact: true })
          .click();
        const waiting = waitResponse(
          (r) =>
            r.url() === origin + "/api/accounts" &&
            r.request().method() === "POST",
        );
        await dialog()
          .getByRole("button", { name: "保存站点", exact: true })
          .click();
        const response = await waiting;
        assert.equal(response.status(), 201);
        added = await response.json();
        // No map click, fit, reload or selection repair is allowed after saving.
        await focus(added.id);
        await dialog().waitFor({ state: "hidden" });
        assert.equal(
          await view.getByLabel("搜索站点", { exact: true }).inputValue(),
          "",
        );
        assert.equal(await node(added.id).getAttribute("data-match"), "true");
        assert.equal(
          await view
            .getByRole("button", { name: "展开分组 保存分组", exact: true })
            .count(),
          0,
        );
        assert.equal(added.group, "保存分组");
        assert.equal(added.balance, null);
      });
      await screenshot("1440-light-save-focus.png");
      return focus(added.id);
    });

    const move = async (
      id: string,
      group: string,
      beforeId: string | null,
      failed = false,
    ) => {
      const previous = await state(),
        secrets = credentialDigests(runtime),
        beforeSelection = await selectedId();
      await view
        .getByRole("button", { name: "显示全部站点", exact: true })
        .click();
      // 显示全部站点 explicitly calls fit; even zero-duration D3 work runs on a frame.
      const beforeCamera = await settledCamera(),
        beforePositions = await positions();
      let release!: () => void,
        intercepted = false;
      const gate = new Promise<void>((ok) => {
        release = ok;
      });
      gates.add(release);
      if (failed) allowHttp("/api/accounts/move", 503);
      await intercept("**/api/accounts/move", async (route) => {
        intercepted = true;
        await gate;
        if (failed)
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"夹具移动保存失败"}',
          });
        else {
          const response = await route.fetch();
          await route.fulfill({ response });
        }
      });
      try {
        await node(id).focus();
        await view.keyboard.press("Alt+m");
        const panel = view.getByTestId("map-move-panel");
        await panel.waitFor();
        assert.equal(
          await selectedId(),
          beforeSelection,
          "Opening another node's mover does not select it",
        );
        await select("移动目标分组", group, panel);
        const before = beforeId
          ? `在 ${(await account(beforeId)).name} 之前`
          : "分组末尾";
        await select("移动插入位置", before, panel);
        const waiting = waitResponse(
          (r) => r.url() === origin + "/api/accounts/move",
        );
        await panel
          .getByRole("button", { name: "保存位置", exact: true })
          .click();
        await until(
          () => intercepted,
          "Move must be waiting at real request boundary",
        );
        await until(
          async () =>
            (await view
              .getByTestId("atlas-map")
              .getAttribute("data-move-pending")) === "true",
          "Optimistic movement ready",
        );
        await pause(200);
        assert.equal(
          await world(),
          beforeCamera,
          "Pending move must not focus its optimistic target",
        );
        assert.equal(
          await selectedId(),
          beforeSelection,
          "Do not select an uncommitted target",
        );
        release();
        const response = await waiting;
        assert.equal(response.status(), failed ? 503 : 200);
        await until(
          async () =>
            (await view
              .getByTestId("atlas-map")
              .getAttribute("data-move-pending")) === "false",
          "Move settled",
        );
        if (failed) {
          assert.equal(
            await world(),
            beforeCamera,
            "Failed move must not pan, fit or focus",
          );
          assert.equal(await selectedId(), beforeSelection);
          assert.deepEqual(
            await positions(),
            beforePositions,
            "Failed move restores committed layout",
          );
          assert.deepEqual(await state(), previous);
        } else {
          await focus(id);
          const next = await state();
          assert.equal(next.accounts.find((a) => a.id === id)!.group, group);
          preserveRecords(previous, next);
        }
        assert.deepEqual(credentialDigests(runtime), secrets);
        return {
          id,
          fromSelection: beforeSelection,
          targetGroup: group,
          failed,
          pendingCameraUnchanged: true,
          finalCamera: await camera(),
          centered: failed ? null : await centered(id),
        };
      } finally {
        release();
        gates.delete(release);
        await view.unroute("**/api/accounts/move");
      }
    };
    await check("selected-within-group-focus-after-success", async () => {
      await noQueries(async () => {
        await move(added.id, "保存分组", fixtures[0].id);
      });
      return focus(added.id);
    });
    await check("selected-cross-group-focus-after-success", async () => {
      await noQueries(async () => {
        await move(added.id, "备用分组", fixtures[4].id);
      });
      return focus(added.id);
    });
    await check("other-within-group-focus-after-success", async () => {
      await noQueries(async () => {
        await move(fixtures[1].id, "保存分组", fixtures[0].id);
      });
      return focus(fixtures[1].id);
    });
    await check("other-cross-group-focus-after-success", async () => {
      await noQueries(async () => {
        await move(fixtures[2].id, "备用分组", null);
      });
      return focus(fixtures[2].id);
    });
    await check("failed-selected-move-rolls-back-without-focus", async () => {
      await noQueries(async () => {
        await move(fixtures[2].id, "保存分组", null, true);
      });
    });
    await check("failed-other-move-keeps-selection-camera", async () => {
      await noQueries(async () => {
        await move(fixtures[0].id, "备用分组", null, true);
      });
    });
    await check("whole-island-move-keeps-camera", async () => {
      await noQueries(async () => {
        const before = await state(),
          secrets = credentialDigests(runtime),
          previousCamera = await world(),
          id = await selectedId();
        const handle = view.locator('[data-group-handle="备用分组"]');
        await handle.focus();
        await view.keyboard.press("Shift+ArrowRight");
        await until(
          async () =>
            (await state()).groupLayout.revision ===
            before.groupLayout.revision + 1,
          "Island movement committed",
        );
        await until(
          async () =>
            (await view
              .getByTestId("atlas-map")
              .getAttribute("data-move-pending")) === "false",
          "Island movement settled",
        );
        assert.equal(await world(), previousCamera);
        assert.equal(await selectedId(), id);
        preserveRecords(before, await state());
        assert.deepEqual(credentialDigests(runtime), secrets);
      });
    });
    await check("ordinary-balance-write-keeps-camera", async () => {
      await noQueries(async () => {
        await clickNode(added.id);
        const before = await state(),
          previousCamera = await world();
        await view
          .locator(".account-detail")
          .getByRole("button", { name: "记录余额", exact: true })
          .click();
        await dialog().getByLabel(/^余额/).fill("17.125");
        await dialog()
          .getByRole("button", { name: "保存记录", exact: true })
          .click();
        await dialog().waitFor({ state: "hidden" });
        await until(
          async () => (await account(added.id)).balance === "17.125",
          "Manual balance recorded",
        );
        assert.equal(await world(), previousCamera);
        assert.equal(await selectedId(), added.id);
        assert.equal(
          (await state()).snapshots.length,
          before.snapshots.length + 1,
        );
      });
    });

    await check("map-title-rename-archived-filter-fold-position", async () => {
      const before = await state(),
        secrets = credentialDigests(runtime),
        nodeBefore = await positions(),
        islandBefore = await islands();
      await noQueries(async () => {
        await select("筛选分组", "保存分组");
        await view
          .getByRole("button", { name: "折叠分组 保存分组", exact: true })
          .and(view.locator(".island-header-action"))
          .click();
        const beforeCamera = await world();
        await view
          .getByRole("button", { name: "改名分组 保存分组", exact: true })
          .click();
        await dialog()
          .getByLabel("新的分组名称", { exact: true })
          .fill("改名保存分组");
        const waiting = waitResponse(
          (r) => r.url() === origin + "/api/map/groups/rename",
        );
        await dialog()
          .getByRole("button", { name: "保存分组名称", exact: true })
          .click();
        assert.equal((await waiting).status(), 200);
        await dialog().waitFor({ state: "hidden" });
        assert.match(
          await view
            .getByRole("combobox", { name: "筛选分组", exact: true })
            .innerText(),
          /改名保存分组/,
        );
        const unfold = view
          .getByRole("button", { name: "展开分组 改名保存分组", exact: true })
          .and(view.locator(".island-header-action"));
        assert.equal(
          await unfold.getAttribute("aria-expanded"),
          "false",
          "Folded state migrates with name",
        );
        assert.equal(
          await view.locator('[data-group-title="保存分组"]').count(),
          0,
        );
        assert.equal(
          await world(),
          beforeCamera,
          "Rename never arbitrarily fits/pans",
        );
        await unfold.click();
        await select("筛选分组", "所有分组");
        const after = await state(),
          changed = before.accounts.filter((a) => a.group === "保存分组");
        assert.ok(changed.some((a) => a.archived));
        for (const a of changed)
          assert.equal(
            after.accounts.find((b) => b.id === a.id)!.group,
            "改名保存分组",
          );
        for (const a of before.accounts)
          if (a.group !== "保存分组")
            assert.deepEqual(
              after.accounts.find((b) => b.id === a.id),
              a,
            );
        preserveRecords(before, after);
        assert.deepEqual(credentialDigests(runtime), secrets);
        assert.deepEqual(
          await positions(),
          nodeBefore,
          "Rename preserves all node world positions",
        );
        assert.deepEqual(
          await islands(),
          islandBefore
            .map((i) => ({
              ...i,
              name: i.name === "保存分组" ? "改名保存分组" : i.name,
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        );
      });
      return {
        archivedIncluded: true,
        foldedStateMigrated: true,
        filterSynchronized: true,
        positionsUnchanged: true,
      };
    });
    await check("list-global-rename-archived-only", async () => {
      await noQueries(async () => {
        const before = await state(),
          secrets = credentialDigests(runtime),
          geometry = await islands(),
          nodes = await positions();
        await view
          .getByRole("button", { name: "列表视图", exact: true })
          .click();
        await openGlobalGroupRename();
        await select("需要改名的分组", /^仅归档分组(?:\s|$)/, dialog());
        await dialog()
          .getByLabel("新的分组名称", { exact: true })
          .fill("归档改名分组");
        await dialog()
          .getByRole("button", { name: "保存分组名称", exact: true })
          .click();
        await dialog().waitFor({ state: "hidden" });
        const after = await state();
        preserveRecords(before, after);
        const archived = fixtures[9];
        assert.ok(archived.archived);
        assert.equal(
          after.accounts.find((a) => a.id === archived.id)!.group,
          "归档改名分组",
        );
        assert.deepEqual(credentialDigests(runtime), secrets);
        await view
          .getByRole("button", { name: "地图视图", exact: true })
          .click();
        await node(added.id).waitFor();
        assert.deepEqual(await positions(), nodes);
        assert.deepEqual(await islands(), geometry); // Archived-only island is outside the active map scope.
      });
    });
    await check("duplicate-rename-rejected-ui-and-api", async () => {
      await noQueries(async () => {
        const before = await state(),
          secrets = credentialDigests(runtime),
          writes = counts.renames;
        await view
          .getByRole("button", { name: "列表视图", exact: true })
          .click();
        await select("筛选分组", "改名保存分组");
        await openGlobalGroupRename();
        await dialog()
          .getByLabel("新的分组名称", { exact: true })
          .fill("备用分组");
        await dialog()
          .getByRole("button", { name: "保存分组名称", exact: true })
          .click();
        await dialog().getByRole("alert").waitFor();
        assert.match(
          await dialog().getByRole("alert").innerText(),
          /已存在|重名/,
        );
        assert.equal(
          counts.renames,
          writes,
          "Client refuses duplicate before POST",
        );
        await dialog()
          .getByRole("button", { name: "取消", exact: true })
          .click();
        await api(
          "map/groups/rename",
          "POST",
          {
            name: "改名保存分组",
            newName: "备用分组",
            expectedRevision: before.groupLayout.revision,
          },
          400,
        );
        assert.deepEqual(await state(), before);
        assert.deepEqual(credentialDigests(runtime), secrets);
        await select("筛选分组", "所有分组");
        await view
          .getByRole("button", { name: "地图视图", exact: true })
          .click();
      });
    });

    // Capture an actual older backend GET after a real UI deletion, then deliver
    // its ORIGINAL bytes only after a newer UI mutation. No canned account list,
    // reload, manual selection repair or DOM/React state mutation is used.
    const delayedDeleteLoad = async (
      removeId: string,
      mutate: (stale: {
        accounts: Account[];
        groupLayout: GroupLayout;
      }) => Promise<string>,
    ) => {
      let release!: () => void,
        captured: { accounts: Account[]; groupLayout: GroupLayout } | undefined,
        seen = false,
        delivered = false;
      const gate = new Promise<void>((ok) => {
        release = ok;
      });
      gates.add(release);
      await intercept("**/api/accounts", async (route) => {
        if (route.request().method() !== "GET" || seen) {
          await route.continue();
          return;
        }
        seen = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        captured = await response.json();
        await gate;
        await route.fulfill({ response }); // Genuine response predating the successful mutation.
        delivered = true;
      });
      try {
        await clickNode(removeId);
        await view
          .locator(".account-detail")
          .getByLabel("更多账号操作", { exact: true })
          .click();
        await view
          .locator(".account-detail")
          .getByRole("button", { name: "删除账号", exact: true })
          .click();
        const deletion = waitResponse(
          (r) =>
            r.url() === origin + `/api/accounts/${removeId}` &&
            r.request().method() === "DELETE",
        );
        await dialog()
          .getByRole("button", { name: "确认删除", exact: true })
          .click();
        assert.equal((await deletion).status(), 200);
        await dialog().waitFor({ state: "hidden" });
        await until(
          () => !!captured,
          "Deletion's load GET captured before mutation",
        );
        assert.ok(
          !captured!.accounts.some((a) => a.id === removeId),
          "Captured server GET already reflects deletion",
        );
        const targetId = await mutate(captured!);
        const afterMutation = await state(),
          cameraAfterMutation = await world();
        assert.equal(await selectedId(), targetId);
        const oldResponse = waitResponse(
          (r) =>
            r.url() === origin + "/api/accounts" &&
            r.request().method() === "GET",
        );
        release();
        const response = await oldResponse;
        await response.finished();
        await until(() => delivered, "Older GET released");
        // Delete's notification is emitted only AFTER its awaited load() has
        // consumed the held response, making this a completion barrier, not a guess.
        await view.getByText("账号与余额历史已删除", { exact: true }).waitFor();
        await pause(300);
        assert.equal(
          await selectedId(),
          targetId,
          "Older GET must not remove/reset selected account",
        );
        assert.equal(
          await world(),
          cameraAfterMutation,
          "Older GET must not cause camera recovery/fit",
        );
        assert.equal(
          await node(targetId).count(),
          1,
          "Successful mutation's account remains in rendered UI",
        );
        assert.deepEqual(
          await state(),
          afterMutation,
          "Older GET is read-only; canonical mutation remains saved",
        );
        return {
          removedId: removeId,
          targetId,
          staleAccountCount: captured!.accounts.length,
          selectedSurvived: true,
          cameraUnchanged: true,
          genuineOldResponseReleased: true,
        };
      } finally {
        release();
        gates.delete(release);
        await view.unroute("**/api/accounts");
      }
    };
    await check(
      "delayed-delete-load-get-cannot-remove-new-saved-focus",
      async () => {
        let evidence: unknown;
        await noQueries(async () => {
          evidence = await delayedDeleteLoad(fixtures[7].id, async (stale) => {
            await view
              .getByRole("button", { name: "添加站点", exact: true })
              .click();
            await dialog()
              .getByRole("button", { name: "下一步", exact: true })
              .click();
            await dialog()
              .getByLabel(/^站点名称/)
              .fill("旧 GET 不能覆盖新建夹具");
            await dialog()
              .getByLabel(/^网站地址/)
              .fill(site);
            await dialog()
              .getByRole("button", { name: "下一步", exact: true })
              .click();
            await dialog()
              .getByRole("button", { name: "继续确认单位", exact: true })
              .click();
            await dialog()
              .getByLabel("我已确认余额单位与查询口径", { exact: true })
              .check();
            await dialog()
              .getByRole("button", { name: "下一步", exact: true })
              .click();
            await select("分组", "改名保存分组", dialog());
            const saved = waitResponse(
              (r) =>
                r.url() === origin + "/api/accounts" &&
                r.request().method() === "POST",
            );
            await dialog()
              .getByRole("button", { name: "保存站点", exact: true })
              .click();
            const response = await saved;
            assert.equal(response.status(), 201);
            const newAccount = (await response.json()) as Account;
            assert.ok(
              !stale.accounts.some((a) => a.id === newAccount.id),
              "Held GET definitely predates account creation",
            );
            await focus(newAccount.id);
            await dialog().waitFor({ state: "hidden" });
            return newAccount.id;
          });
        });
        return evidence;
      },
    );
    await check(
      "delayed-delete-load-get-cannot-undo-rename-selection",
      async () => {
        let evidence: unknown;
        await noQueries(async () => {
          evidence = await delayedDeleteLoad(fixtures[6].id, async (stale) => {
            const id = fixtures[3].id;
            assert.equal(
              stale.accounts.find((a) => a.id === id)!.group,
              "改名保存分组",
            );
            await clickNode(id);
            await select("筛选分组", "改名保存分组");
            await view
              .getByRole("button", {
                name: "改名分组 改名保存分组",
                exact: true,
              })
              .click();
            await dialog()
              .getByLabel("新的分组名称", { exact: true })
              .fill("竞态改名分组");
            const renamed = waitResponse(
              (r) => r.url() === origin + "/api/map/groups/rename",
            );
            await dialog()
              .getByRole("button", { name: "保存分组名称", exact: true })
              .click();
            assert.equal((await renamed).status(), 200);
            await dialog().waitFor({ state: "hidden" });
            assert.equal((await account(id)).group, "竞态改名分组");
            return id;
          });
          // Check client group/filter/detail after the delayed response, not only SQLite.
          assert.equal(
            await view.locator('[data-group-title="改名保存分组"]').count(),
            0,
          );
          assert.equal(
            await view.locator('[data-group-title="竞态改名分组"]').count(),
            1,
          );
          assert.match(
            await view
              .getByRole("combobox", { name: "筛选分组", exact: true })
              .innerText(),
            /竞态改名分组/,
          );
          assert.ok(
            (
              await view.locator(".account-detail .detail-meta").innerText()
            ).includes("竞态改名分组"),
          );
          assert.equal(
            await node(fixtures[3].id).getAttribute("data-match"),
            "true",
          );
          await select("筛选分组", "所有分组");
        });
        return evidence;
      },
    );

    const showDiagnostic = async (
      scope: Locator,
      d: Record<string, unknown>,
    ) => {
      const region = scope.getByRole("region", {
        name: "查询诊断",
        exact: true,
      });
      await region.waitFor();
      if ((await region.locator("details").getAttribute("open")) === null)
        await region.locator("summary").click();
      if (d.response) {
        const features = region.getByLabel("脱敏响应特征", { exact: true });
        await features.waitFor();
        const text = await features.innerText();
        for (const label of [
          "内容类型",
          "压缩编码",
          "正文分类",
          "字节数",
          "JSON 类型",
          "gzip",
        ])
          assert.ok(text.includes(label), "Response feature shown: " + label);
        const response = d.response as {
          wireBytes: number;
          decodedBytes: number;
        };
        assert.ok(
          text.includes(String(response.wireBytes)) &&
            text.includes(String(response.decodedBytes)),
        );
      } else {
        assert.equal(
          await region.getByLabel("脱敏响应特征", { exact: true }).count(),
          0,
          "Unread auth-error body must not show invented response features",
        );
      }
      await region
        .getByRole("button", { name: "复制脱敏报告", exact: true })
        .click();
      const manual = region.getByLabel("脱敏诊断报告", { exact: true });
      const report = (await manual.count())
        ? await manual.inputValue()
        : await view.evaluate(() => navigator.clipboard.readText());
      assert.deepEqual(
        JSON.parse(report),
        d,
        "Copied UI report is the exact diagnostic whitelist",
      );
    };
    const savedQuery = async (
      a: Account,
      operation: "test" | "sync",
      identity: Identity,
      failed = false,
    ) => {
      await clickNode(a.id);
      const before = await state(),
        secrets = credentialDigests(runtime),
        cameraBefore = await world(),
        hits = counts.provider;
      if (failed) {
        failIdentity = identity;
        allowHttp(`/api/accounts/${a.id}/${operation}`, 502);
      }
      try {
        const waiting = waitResponse(
          (r) => r.url() === origin + `/api/accounts/${a.id}/${operation}`,
        );
        await view
          .locator(".account-detail")
          .getByRole("button", {
            name: operation === "test" ? "测试连接" : "刷新余额",
            exact: true,
          })
          .click();
        const response = await waiting,
          body = await response.json();
        assert.equal(response.status(), failed ? 502 : 200);
        await until(
          async () =>
            !(await view
              .locator(".account-detail")
              .getByRole("button", {
                name: operation === "test" ? "测试连接" : "刷新余额",
                exact: true,
              })
              .isDisabled()),
          "Query UI ready",
        );
        assert.equal(
          counts.provider,
          hits + 1,
          "Exactly one real local provider request per click",
        );
        const sample = observed.at(-1)!;
        assert.equal(sample.identity, identity);
        const d = diagnostic(
          operation === "test" || failed
            ? body.diagnostic
            : body.lastQueryDiagnostic,
          (await account(a.id)).query.requestProfile || "atlas",
          sample,
          failed ? "failure" : "success",
        );
        assert.equal(d.operation, operation);
        const after = await state();
        if (operation === "test" || failed) preserveRecords(before, after);
        else assert.equal(after.snapshots.length, before.snapshots.length + 1);
        const otherId = identity === "alpha" ? beta.id : alpha.id;
        assert.deepEqual(
          after.accounts.find((b) => b.id === otherId),
          before.accounts.find((b) => b.id === otherId),
          "Query must not touch the other same-domain account",
        );
        assert.deepEqual(
          after.snapshots.filter((s) => s.accountId === otherId),
          before.snapshots.filter((s) => s.accountId === otherId),
        );
        assert.equal(
          await world(),
          cameraBefore,
          "Ordinary query result does not change camera",
        );
        assert.equal(await selectedId(), a.id);
        assert.deepEqual(credentialDigests(runtime), secrets);
        await showDiagnostic(view.locator(".account-detail"), d);
        return d;
      } finally {
        failIdentity = null;
      }
    };
    await check("editor-atlas-cc-switch-gzip-diagnostic", async () => {
      const atlas = await savedQuery(alpha, "test", "alpha");
      await noQueries(async () => {
        const before = await state(),
          secrets = credentialDigests(runtime);
        await view
          .locator(".account-detail")
          .getByRole("button", { name: "编辑档案", exact: true })
          .click();
        await select("请求特征", /^CC Switch 模板请求头(?:\s|$)/, dialog());
        await dialog()
          .getByRole("button", { name: "保存站点", exact: true })
          .click();
        await dialog().waitFor({ state: "hidden" });
        await focus(alpha.id);
        preserveRecords(before, await state());
        assert.deepEqual(
          credentialDigests(runtime),
          secrets,
          "Blank editor key retains encrypted credential",
        );
        assert.equal(
          (await account(alpha.id)).query.requestProfile,
          "cc-switch",
        );
      });
      const cc = await savedQuery(alpha, "test", "alpha");
      return {
        atlas: { profile: atlas.requestProfile, response: atlas.response },
        ccSwitch: { profile: cc.requestProfile, response: cc.response },
      };
    });
    await check("wizard-atlas-cc-switch-gzip-test-no-persistence", async () => {
      const before = await state(),
        secrets = credentialDigests(runtime);
      await noQueries(async () => {
        await view
          .getByRole("button", { name: "添加站点", exact: true })
          .click();
        await dialog()
          .getByRole("radio", { name: "New API · 账户余额", exact: true })
          .check();
        await dialog()
          .getByRole("button", { name: "下一步", exact: true })
          .click();
        await dialog()
          .getByLabel(/^站点名称/)
          .fill("取消的 NewAPI 草稿夹具");
        await dialog()
          .getByLabel(/^网站地址/)
          .fill(site);
        await dialog().getByLabel("管理接口根地址", { exact: true }).fill(site);
        await dialog()
          .getByLabel("用户管理令牌", { exact: true })
          .fill(identities.alpha.key);
        await dialog()
          .getByLabel("用户 ID（站点要求时必填）", { exact: true })
          .fill(identities.alpha.userId);
        await dialog().getByText("高级连接设置", { exact: true }).click();
        assert.match(
          await dialog()
            .getByRole("combobox", { name: "请求特征", exact: true })
            .innerText(),
          /Atlas 默认/,
        );
        await dialog()
          .getByRole("button", { name: "下一步", exact: true })
          .click();
      });
      for (const profile of ["atlas", "cc-switch"] as const) {
        if (profile === "cc-switch")
          await noQueries(async () => {
            await dialog()
              .getByRole("button", { name: "上一步", exact: true })
              .click();
            // Each wizard step is remounted; advanced details starts closed again.
            await dialog().getByText("高级连接设置", { exact: true }).click();
            await select("请求特征", /^CC Switch 模板请求头(?:\s|$)/, dialog());
            await dialog()
              .getByRole("button", { name: "下一步", exact: true })
              .click();
          });
        const waiting = waitResponse(
          (r) => r.url() === origin + "/api/query/test",
        );
        const hits = counts.provider;
        await dialog()
          .getByRole("button", { name: "测试连接", exact: true })
          .click();
        const response = await waiting;
        assert.equal(response.status(), 200);
        const body = await response.json();
        assert.equal(counts.provider, hits + 1);
        assert.equal(observed.at(-1)!.identity, "alpha");
        const d = diagnostic(body.diagnostic, profile, observed.at(-1)!);
        assert.equal(d.operation, "test");
        await until(
          async () =>
            !(await dialog()
              .getByRole("button", { name: "测试连接", exact: true })
              .isDisabled()),
          "Draft result rendered",
        );
        await showDiagnostic(dialog(), d);
        assert.deepEqual(
          await state(),
          before,
          "Draft test writes no account, diagnostic, balance or history",
        );
        assert.deepEqual(credentialDigests(runtime), secrets);
      }
      await screenshot("1440-light-wizard-gzip.png");
      await noQueries(async () => {
        await dialog()
          .getByRole("button", { name: "关闭对话框", exact: true })
          .click();
      });
      assert.deepEqual(await state(), before);
    });
    await check("same-domain-two-accounts-isolated", async () => {
      assert.notEqual(alpha.id, beta.id);
      assert.equal(alpha.siteUrl, beta.siteUrl);
      assert.equal(alpha.provider, beta.provider);
      const beforeSecrets = credentialDigests(runtime);
      assert.notEqual(beforeSecrets[alpha.id], beforeSecrets[beta.id]);
      await savedQuery(alpha, "sync", "alpha");
      assert.equal((await account(alpha.id)).balance, "2.5");
      assert.equal((await account(beta.id)).balance, identities.beta.initial);
      await noQueries(async () => {
        await view.getByTestId("query-route-proxy").click();
        await until(
          async () =>
            (await view
              .getByTestId("query-route-proxy")
              .getAttribute("aria-pressed")) === "true" &&
            !(await view.getByTestId("query-route-direct").isDisabled()),
          "Proxy route selected without querying",
        );
      });
      const d = await savedQuery(beta, "sync", "beta");
      assert.equal(d.routeMode, "proxy");
      assert.equal((await account(beta.id)).balance, "8.5");
      assert.equal((await account(alpha.id)).balance, "2.5");
      await noQueries(async () => {
        await view.getByTestId("query-route-direct").click();
        await until(
          async () =>
            (await view
              .getByTestId("query-route-direct")
              .getAttribute("aria-pressed")) === "true" &&
            !(await view.getByTestId("query-route-direct").isDisabled()),
          "Direct route restored",
        );
      });
      await savedQuery(alpha, "test", "alpha", true);
      await savedQuery(alpha, "sync", "alpha", true);
      assert.equal(
        (await account(alpha.id)).balance,
        "2.5",
        "Failure must not clear the last good balance",
      );
      assert.equal((await account(beta.id)).balance, "8.5");
      const final = await state();
      for (const a of [alpha, beta]) {
        const history = final.snapshots.filter((s) => s.accountId === a.id);
        assert.equal(history.length, 2);
        assert.ok(history.every((s) => s.accountId === a.id));
      }
      assert.deepEqual(credentialDigests(runtime), beforeSecrets);
      return {
        sameDomain: true,
        differentIdsAndCiphertext: true,
        alphaBalance: "2.5",
        betaBalance: "8.5",
        historiesPerAccount: 2,
        failedTestAndSyncPreservedBalances: true,
      };
    });

    for (const width of [375, 768, 1440])
      for (const theme of ["light", "dark"] as const)
        await check(`viewport-${width}-${theme}`, async () => {
          await noQueries(async () => {
            await view.setViewportSize({
              width,
              height: width === 375 ? 812 : 960,
            });
            const next = theme === "dark" ? "切换到深色" : "切换到浅色";
            const button = view.getByRole("button", {
              name: next,
              exact: true,
            });
            if (await button.count()) await button.click();
            await until(
              async () =>
                (await view.locator("html").getAttribute("data-theme")) ===
                theme,
              "Persisted UI theme applied",
            );
            await focus(alpha.id); // Resize focuses the selected node, but never queries.
            const overflow = await view.evaluate(() => ({
              width: innerWidth,
              scroll: document.documentElement.scrollWidth,
            }));
            assert.ok(
              overflow.scroll <= overflow.width + 2,
              "Page has horizontal viewport overflow",
            );
            await screenshot(`${width}-${theme}-map-diagnostic.png`);
            await view
              .locator(".account-detail")
              .getByRole("button", { name: "编辑档案", exact: true })
              .click();
            await dialog()
              .getByRole("combobox", { name: "请求特征", exact: true })
              .waitFor();
            const boxes = await dialog().evaluate((e) => ({
              width: e.clientWidth,
              scroll: e.scrollWidth,
              left: e.getBoundingClientRect().left,
              right: e.getBoundingClientRect().right,
            }));
            assert.ok(
              boxes.left >= -2 &&
                boxes.right <= width + 2 &&
                boxes.scroll <= boxes.width + 2,
              "Editor overflow",
            );
            // Only two extra editor screenshots; six map/diagnostic screenshots cover all widths/themes.
            if (width === 375)
              await screenshot(`${width}-${theme}-editor-profile.png`);
            await dialog()
              .getByRole("button", { name: "关闭对话框", exact: true })
              .click();
          });
          return { width, theme, horizontalOverflow: false };
        });
    await check("idle-navigation-route-switch-no-query", async () => {
      const before = await state();
      await noQueries(async () => {
        await view.setViewportSize({ width: 1440, height: 960 });
        for (const mode of ["proxy", "direct"] as const) {
          await view.getByTestId("query-route-" + mode).click();
          await until(
            async () =>
              (await view
                .getByTestId("query-route-" + mode)
                .getAttribute("aria-pressed")) === "true" &&
              !(await view.getByTestId("query-route-direct").isDisabled()),
            "Line switched",
          );
        }
        await view
          .getByRole("button", { name: "列表视图", exact: true })
          .click();
        await view
          .getByRole("button", { name: "地图视图", exact: true })
          .click();
        await view.reload();
        await view.getByTestId("atlas-map").waitFor();
        await pause(1500);
      });
      assert.deepEqual((await state()).accounts, before.accounts);
      assert.deepEqual((await state()).snapshots, before.snapshots);
      return {
        idleMs: 1500,
        routeChangesQueryFree: true,
        reloadQueryFree: true,
      };
    });
    await check("browser-fixture-errors-and-query-counts", async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(fixtureErrors, []);
      assert.equal(counts.creates, 2);
      assert.equal(counts.deletes, 2);
      assert.equal(counts.moves, 6);
      assert.equal(counts.groupMoves, 1);
      assert.equal(counts.renames, 3);
      assert.equal(counts.draftTests, 2);
      assert.equal(counts.savedTests, 3);
      assert.equal(counts.syncs, 3);
      assert.equal(counts.provider, 8);
      assert.equal(counts.proxyConnect, 1);
      assert.equal(
        counts.provider,
        counts.draftTests + counts.savedTests + counts.syncs,
      );
      assert.ok(observed.every((r) => r.authValid && r.userIdValid));
      assert.equal(
        readFileSync(join(runtime.runtime, ".next/BUILD_ID"), "utf8").trim(),
        build!.buildId,
      );
      const stored = await view.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          url: location.href,
        }),
      );
      for (const i of Object.values(identities))
        assert.ok(
          !stored.includes(i.key),
          "Fixture credential leaked to browser persistence",
        );
      assert.ok(
        screenshots.length <= 40,
        "Keep artifacts small; never record a trace",
      );
      return { ...counts, allQueriesExactlyMatchExplicitClicks: true };
    });
    await check("negative-world-reload-overview-and-hand-pan", async () => {
      await noQueries(async () => {
        const before = await state(), name = "备用分组";
        const light = view.getByRole("button", { name: "切换到浅色", exact: true });
        if (await light.count()) await light.click();
        // Explicit synthetic fixture setup; never mutates a deployed account.
        await api("map/groups/move", "POST", { name, position: { x: -600, y: -450 }, expectedRevision: before.groupLayout.revision });
        await view.reload();
        await view.getByTestId("atlas-map").waitFor();
        // The decorative inner ring uses .445/.435 of the island size; undo
        // those factors to compare its centre against the saved island origin.
        await until(async () => (await islands()).some(i => i.name === name && Math.abs(Number(i.cx) - Number(i.rx) / 0.89 + 600) < 0.1 && Math.abs(Number(i.cy) - Number(i.ry) / 0.87 + 450) < 0.1), "Reload must render the saved negative island");
        const restored = await state();
        assert.deepEqual(restored.groupLayout.positions.find(p => p.name === name), { name, x: -600, y: -450 });
        preserveRecords(before, restored);
        await view.getByRole("button", { name: "显示全部站点", exact: true }).click();
        await settledCamera();
        const minimapToggle = view.getByRole("button", { name: "定位小窗", exact: true });
        if (await minimapToggle.getAttribute("aria-pressed") !== "true") await minimapToggle.click();
        const domain = (await view.getByTestId("map-minimap").locator("svg").getAttribute("viewBox"))!.split(/\s+/).map(Number);
        assert.ok(domain[0] < -600 && domain[1] < -450, "Overview must include the full negative island");
        const target = restored.accounts.find(a => a.group === name && !a.archived)!;
        await node(target.id).focus(); await node(target.id).press("Enter"); await focus(target.id);
        const saved = await state(), layout = await positions(), id = await selectedId();
        for (const kind of ["space", "middle"] as const) {
          await view.locator(".atlas-svg").focus();
          const start = await camera(), point = await node(target.id).evaluate(e => {
            const m = (e as unknown as SVGGraphicsElement).getScreenCTM()!; return { x: m.e, y: m.f };
          });
          await view.mouse.move(point.x, point.y);
          if (kind === "space") {
            await view.keyboard.down("Space");
            assert.equal(await view.locator(".atlas-svg").getAttribute("data-space-pan"), "true");
          }
          const button = kind === "middle" ? "middle" : "left";
          await view.mouse.down({ button });
          await view.mouse.move(point.x + 96, point.y + 68, { steps: 8 });
          await view.mouse.up({ button });
          if (kind === "space") await view.keyboard.up("Space");
          await settledCamera();
          const end = await camera();
          assert.ok(Math.abs(end.x - start.x - 96) < 2 && Math.abs(end.y - start.y - 68) < 2, `${kind} must pan from a node`);
          assert.equal(end.k, start.k);
          assert.equal(await selectedId(), id);
          assert.deepEqual(await positions(), layout);
          assert.deepEqual(await state(), saved);
          assert.equal(await view.getByTestId("atlas-map").getAttribute("data-hand-pan"), null);
          assert.equal(await view.locator(".atlas-svg").getAttribute("data-space-pan"), null);
        }
        await screenshot("1440-light-negative-world-hand-pan.png");
        assert.deepEqual(errors, []); assert.deepEqual(fixtureErrors, []);
      });
      return { negativePosition: { x: -600, y: -450 }, reloadPreserved: true, overviewContainsNegativeIsland: true, spaceAndMiddlePanFromNodes: true, dataUnchangedByPan: true };
    });
    await check("appearance-persistence-ink-backgrounds-and-geometric-loading", async () => {
      return noQueries(async () => {
        const result = await verifyAppearance(view, out, {
          read: async () => (await api("accounts")).settings,
          save: value => api("settings", "PATCH", value), select,
        });
        screenshots.push(...result.screenshots); assert.ok(screenshots.length <= 40); return result;
      });
    });
  };
  try {
    // Cancellation closes only owned children/browser and releases held routes.
    // Await run's unwind BEFORE filesystem cleanup (no abandoned background run).
    await run();
  } catch (e) {
    failure = e;
    if (page && !page.isClosed())
      await deadline(
        page.screenshot({ path: join(out, "failure.png") }),
        4000,
        "Failure screenshot timeout",
      )
        .then(() => screenshots.push("failure.png"))
        .catch(() => {});
    abort.abort(e);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const clean = async (
      label: string,
      work: () => unknown | Promise<unknown>,
    ) => {
      try {
        await work();
      } catch (e) {
        cleanupErrors.push(label + ": " + message(e));
      }
    };
    await clean("browser", async () => {
      if (browser)
        await deadline(browser.close(), 8000, "Browser close timeout");
    });
    await clean("owned next start", async () => {
      await stopOwnedChild(child);
      childStopped = true;
    });
    for (const socket of sockets) socket.destroy();
    for (const [label, s] of [
      ["provider", provider],
      ["proxy", proxy],
    ] as const)
      await clean(label, async () => {
        s.closeAllConnections();
        if (s.listening)
          await deadline(
            new Promise<void>((ok, fail) =>
              s.close((e) => (e ? fail(e) : ok())),
            ),
            5000,
            label + " close timeout",
          );
      });
    await clean("original 3000 service owner", async () => {
      ownersAfter = await owners3000();
      assert.deepEqual(
        ownersAfter,
        ownersBefore,
        "3000 listener PID/start time changed",
      );
    });
    await clean("repository .next untouched", () => {
      buildAfter = repositoryBuildStamp(root);
      assert.deepEqual(
        buildAfter,
        buildBefore,
        "Repository .next metadata changed",
      );
    });
    await clean("owned source/runtime/junction/SQLite", () => {
      assert.ok(
        childStopped,
        "Retain runtime when owned server is not confirmed stopped",
      );
      if (owned) cleanupIsolatedSource(owned);
      tempRemoved = true;
    });
    writeFileSync(join(out, "build-stdout.log"), redact(buildLog.text()));
    writeFileSync(join(out, "server.log"), redact(serverLog.text()));
    const notRun = required.filter(
      (name) => !checks.some((c) => c.name === name),
    );
    const status =
      !failure &&
      !cleanupErrors.length &&
      !errors.length &&
      !fixtureErrors.length &&
      !notRun.length
        ? "PASS"
        : "FAIL";
    const report = {
      status,
      phase,
      checks,
      notRun,
      errors,
      fixtureErrors,
      expectedHttpErrors,
      cleanupErrors,
      buildID: build?.buildId || null,
      build,
      newProductionBuild: !!build,
      reusedRepositoryBuild: false,
      sourceFingerprint: owned?.sourceFingerprint,
      copiedFiles: owned?.copiedFiles,
      copiedBytes: owned?.copiedBytes,
      originalService: {
        port: 3000,
        ownersBefore,
        ownersAfter,
        unchanged: JSON.stringify(ownersBefore) === JSON.stringify(ownersAfter),
      },
      repositoryNext: {
        before: buildBefore,
        after: buildAfter,
        unchanged: JSON.stringify(buildBefore) === JSON.stringify(buildAfter),
      },
      fixture: {
        port: providerPort,
        proxyPort,
        requestCounts: counts,
        requests: observed,
        amountsAreSynthetic: true,
        realCredentialsRead: false,
        realProvidersQueried: false,
      },
      port,
      childPid: child?.pid,
      isolation: {
        cleanRuntimeEnv: true,
        sourceWhitelist: [
          "src",
          "tests",
          "scripts",
          "public",
          "explicit package/lock/config files",
        ],
        envFilesReadOrCopied: false,
        dependencyJunctionTargetVerified: true,
        followLinksOnCleanup: false,
        windowsHidden: true,
        traceRecorded: false,
      },
      childStopped,
      tempRemoved,
      screenshots,
      boundedLogBytes: {
        buildRetained: Buffer.byteLength(buildLog.text()),
        buildObserved: buildLog.bytes(),
        serverRetained: Buffer.byteLength(serverLog.text()),
      },
      failure: failure ? message(failure) : null,
      artifacts: out,
    };
    writeFileSync(
      join(out, "verification.json"),
      redact(JSON.stringify(report, null, 2)),
    );
    console.log(
      JSON.stringify(
        {
          status,
          buildID: report.buildID,
          passed: checks.filter((c) => c.status === "PASS").length,
          checks: checks.map((c) => ({ name: c.name, status: c.status })),
          notRun,
          errors,
          fixtureErrors,
          cleanupErrors,
          originalService: report.originalService,
          fixtureRequestCounts: counts,
          childStopped,
          tempRemoved,
          artifacts: out,
        },
        null,
        2,
      ),
    );
    if (status !== "PASS") process.exitCode = 1;
  }
  if (failure) throw failure;
}

main().catch((e) => {
  console.error(message(e));
  process.exitCode = 1;
});
