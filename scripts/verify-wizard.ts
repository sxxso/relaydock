import { assertDiagnosticFeatures } from "./diagnostic-feature-contract";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { chromium, type Locator, type Page, type Request } from "playwright";
import { hashPassword } from "../src/lib/crypto";
import { platforms, type Provider } from "../src/lib/platform-catalog";

// Standalone, existing-production-build acceptance. No build, install, :3000,
// shared DB, .env load, real provider, Git writes, UI mock or API interception.
// node node_modules/tsx/dist/cli.mjs scripts/verify-wizard.ts --red-only
// After the main thread builds: run without --red-only for full acceptance.
// A missing wizard exits 1 and records RED; --red-only cannot report GREEN.
// :3321 is fixed. Occupied ports are a failure, never a reason to kill an owner.
const port = 3321;
const origin = `http://127.0.0.1:${port}`;
const globalTimeoutMs = 240_000;
const password = "fixture-wizard-password-123";
const credential = "fixture-wizard-query-secret";
const changedCredential = "fixture-wizard-replaced-secret";
const userId = "24681357";
const privateDomain = "fixture-wizard-private.invalid";
const prefix = "/fixture-wizard-private";
const headings = [
  "选择查询口径",
  "地址与凭据",
  "点击测试，不记录余额",
  "确认余额单位",
  "确认并保存",
] as const;
const steps = ["1 平台", "2 地址与凭据", "3 点击测试", "4 确认单位", "5 保存"];
const diagnosticKeys = [
  "schemaVersion",
  "provider",
  "operation",
  "startedAt",
  "finishedAt",
  "totalMs",
  "timeoutSeconds",
  "dnsMode",
  "outcome",
  "category",
  "code",
  "httpStatus",
  "stages",
];
const queryDefaults = {
  timeoutSeconds: 10,
  path: "/user/balance",
  balancePath: "balance",
  subtractPath: "",
  divisor: "1",
  authHeader: "Authorization",
};
type Json = Record<string, unknown>;
type Mode = "account" | "token" | "auth" | "zero" | "hold" | "deepseek";
type Draft = {
  provider: Exclude<Provider, "manual">;
  siteUrl: string;
  apiUrl: string;
  managementUrl: string;
  userId: string;
  query: typeof queryDefaults;
  unit: string;
  quotaPerUnit: null;
  credential?: string;
};
type Metrics = {
  provider: number;
  draft: number;
  savedQuery: number;
  creates: number;
};
type DbEvidence = {
  accounts: number;
  snapshots: number;
  credentials: number;
  fingerprint: string;
};
type State = { accounts: Json[]; snapshots: Json[]; db: DbEvidence };
type Check = {
  name: string;
  status: "PASS" | "FAIL";
  before: Metrics;
  after: Metrics;
};
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const object = (value: unknown, label: string): Json => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Json;
};
const keys = (value: Json, expected: string[], label: string) =>
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
const redact = (text: string) =>
  [credential, changedCredential, password].reduce(
    (result, secret) => result.split(secret).join("[REDACTED FIXTURE]"),
    text,
  );
const message = (e: unknown) =>
  redact(e instanceof Error ? e.message : String(e));

async function until(
  condition: () => boolean | Promise<boolean>,
  label: string,
  ms = 6000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await pause(50);
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
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requireFreePort() {
  assert.ok(port !== Number(3000) && ![3317, 3318, 3319, 3320].includes(port));
  const probe = createPortProbe();
  try {
    await new Promise<void>((ok, fail) => {
      probe.once("error", fail);
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, ok);
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE")
      throw new Error(
        "Isolated wizard port 3321 is occupied; no existing listener was stopped.",
      );
    throw e;
  } finally {
    if (probe.listening)
      await new Promise<void>((ok, fail) =>
        probe.close((e) => (e ? fail(e) : ok())),
      );
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  // Do not forward NODE_OPTIONS, proxies, RELAYDOCK_*, passwords or vault keys.
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "PATH",
    "Path",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function copyBuild(cwd: string, runtime: string, buildId: string) {
  const source = join(cwd, ".next"),
    target = join(runtime, ".next");
  mkdirSync(target, { recursive: true });
  const safeFile = (path: string) =>
    !/^\.env(?:\.|$)/i.test(basename(path)) &&
    !/\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/i.test(path);
  // Never copy the repository root, traced standalone tree, dev build or cache.
  // Next loads environment files relative to this clean temporary runtime only.
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const allowedDirectory = ["server", "static", "node_modules"].includes(
      entry.name,
    );
    const allowedFile =
      entry.isFile() &&
      (entry.name === "BUILD_ID" || /\.(?:json|js)$/.test(entry.name));
    if (allowedDirectory || allowedFile)
      cpSync(join(source, entry.name), join(target, entry.name), {
        recursive: true,
        dereference: true,
        filter: safeFile,
      });
  }
  if (existsSync(join(cwd, "public")))
    cpSync(join(cwd, "public"), join(runtime, "public"), {
      recursive: true,
      filter: safeFile,
    });
  // Reuse the installed packages, without installing or copying any .env/DB.
  symlinkSync(
    join(cwd, "node_modules"),
    join(runtime, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(readFileSync(join(target, "BUILD_ID"), "utf8").trim(), buildId);
  assert.ok(!readdirSync(runtime).some((name) => /^\.env(?:\.|$)/i.test(name)));
}

async function stopOwnedServer(server: ReturnType<typeof spawn> | undefined) {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null)
    return;
  const exited = new Promise<void>((r) => server.once("exit", () => r()));
  server.kill();
  try {
    await deadline(exited, 5000, "Owned next start did not stop");
  } catch {
    server.kill("SIGKILL");
    await deadline(
      exited,
      5000,
      "Owned next start still running; temporary files retained",
    );
  }
}

function dbSnapshot(temp: string): DbEvidence {
  // This is the generated DB, not the app's normal data directory. No Store
  // singleton/import is used, so verification cannot initialize a real vault.
  const path = realpathSync(join(temp, "data", "atlas.sqlite"));
  const dataDir = realpathSync(join(temp, "data"));
  assert.equal(dirname(path), dataDir);
  assert.equal(dirname(dataDir), realpathSync(temp));
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const accounts = db
      .prepare("SELECT id,payload,secret FROM accounts ORDER BY id")
      .all() as { id: string; payload: string; secret: string | null }[];
    const snapshots = db
      .prepare("SELECT id,account_id,payload,at FROM snapshots ORDER BY id")
      .all();
    const settings = db
      .prepare("SELECT key,value FROM meta WHERE key='settings'")
      .all();
    // Credential ciphertext stays in memory and only enters a one-way digest.
    return {
      accounts: accounts.length,
      snapshots: snapshots.length,
      credentials: accounts.filter((a) => a.secret !== null).length,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ accounts, snapshots, settings }))
        .digest("hex"),
    };
  } finally {
    db.close();
  }
}

function assertDiagnostic(
  input: unknown,
  provider: Provider,
  code: string,
  httpStatus: number,
  timeoutSeconds: number,
): Json {
  const d = object(input, "draft diagnostic object");
  keys(
    d,
    [...diagnosticKeys, ...assertDiagnosticFeatures(d)],
    "diagnostic whitelist (no identity, credential, URL or response body)",
  );
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.provider, provider);
  assert.equal(d.operation, "test");
  assert.equal(d.code, code);
  assert.equal(d.httpStatus, httpStatus);
  assert.equal(d.timeoutSeconds, timeoutSeconds);
  assert.equal(d.dnsMode, "system");
  assert.equal(d.routeMode, "direct");
  assert.equal(d.outcome, code === "ok" ? "success" : "failure");
  assert.equal(d.category, code === "ok" ? "success" : "auth");
  assert.ok(
    typeof d.totalMs === "number" &&
      Number.isFinite(d.totalMs) &&
      d.totalMs >= 0,
  );
  assert.ok(
    typeof d.startedAt === "string" && Number.isFinite(Date.parse(d.startedAt)),
  );
  assert.ok(
    typeof d.finishedAt === "string" &&
      Number.isFinite(Date.parse(d.finishedAt)),
  );
  assert.ok(
    Date.parse(d.finishedAt as string) >= Date.parse(d.startedAt as string),
  );
  assert.ok(Array.isArray(d.stages));
  assert.deepEqual(
    d.stages.map((s) => object(s, "stage").id),
    ["dns", "connect", "response", "read", "parse"],
  );
  for (const stage of d.stages)
    keys(
      object(stage, "stage"),
      ["id", "status", "durationMs"],
      "stage whitelist",
    );
  const serialized = JSON.stringify(d);
  for (const forbidden of [
    credential,
    changedCredential,
    password,
    userId,
    "localhost",
    "127.0.0.1",
    privateDomain,
    prefix,
    '"balance":',
    '"rawQuota":',
    '"headers":',
    '"body":',
    "FIXTURE · Wizard",
  ])
    assert.ok(
      !serialized.includes(forbidden),
      "diagnostic leaked private fixture material",
    );
  return d;
}

async function noOverflow(page: Page) {
  const sizes = await page.evaluate(() => {
    const viewport = innerWidth;
    const elements = Array.from(
      document.querySelectorAll(
        '[role="dialog"], [role="listbox"], ol[aria-label="配置进度"], [role="region"][aria-label="查询诊断"]',
      ),
    )
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const box = el.getBoundingClientRect();
        return {
          role: el.getAttribute("role") || el.tagName,
          client: el.clientWidth,
          scroll: el.scrollWidth,
          left: box.left,
          right: box.right,
        };
      });
    const clippedControls = Array.from(
      document.querySelectorAll(
        '[role="dialog"] input, [role="dialog"] button, [role="dialog"] textarea',
      ),
    )
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.left < -1 || box.right > viewport + 1;
      })
      .map((el) => el.getAttribute("aria-label") || el.tagName);
    return {
      viewport,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      elements,
      clippedControls,
    };
  });
  assert.ok(
    sizes.root <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1,
    "page horizontal overflow: " + JSON.stringify(sizes),
  );
  assert.ok(
    sizes.elements.every(
      (el) =>
        el.scroll <= el.client + 1 &&
        el.left >= -1 &&
        el.right <= sizes.viewport + 1,
    ),
    "dialog/progress/select/diagnostic overflow: " + JSON.stringify(sizes),
  );
  assert.deepEqual(
    sizes.clippedControls,
    [],
    "wizard controls must remain inside the viewport",
  );
}

async function screenshot(page: Page, path: string) {
  // Artifact-only caption, added AFTER real layout assertions; never a UI mock.
  await page.evaluate(() => {
    const caption = document.createElement("div");
    caption.id = "wizard-fixture-caption";
    caption.textContent = "FIXTURE · 隔离测试数据，非真实站点/余额";
    caption.style.cssText =
      "position:fixed;bottom:4px;left:4px;z-index:2147483647;" +
      "max-width:calc(100vw - 8px);box-sizing:border-box;padding:4px 8px;" +
      "background:#17232e;color:white;font:11px/1.4 sans-serif;pointer-events:none";
    document.body.append(caption);
  });
  try {
    await page.screenshot({
      path,
      fullPage: true,
      animations: "disabled",
      timeout: 3000,
    });
  } finally {
    await page
      .evaluate(() =>
        document.getElementById("wizard-fixture-caption")?.remove(),
      )
      .catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.every((a) => a === "--red-only"),
    "Only supported flag: --red-only",
  );
  const redOnly = args.includes("--red-only"),
    cwd = resolve(process.cwd());
  const runId =
    new Date().toISOString().replace(/[:.]/g, "-") +
    `-${process.pid}-${randomBytes(4).toString("hex")}`;
  const out = join(cwd, "output", "playwright", "wizard", runId);
  mkdirSync(out, { recursive: true });
  let temp: string | undefined,
    runtime: string | undefined,
    buildId = "";
  let server: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    page: Page | undefined;
  let logs = "",
    checkpoint = "preflight",
    failure: unknown,
    missingWizard = false;
  let providerHits = 0,
    draftPosts = 0,
    savedQueryRequests = 0,
    accountPosts = 0;
  let apiBusyProbes = 0,
    childStopped = false,
    browserClosed = false;
  let fixtureClosed = false,
    temporaryFilesRemoved = false,
    buildUnchanged = false;
  const checks: Check[] = [],
    errors: string[] = [],
    fixtureErrors: string[] = [];
  const cleanupErrors: string[] = [],
    screenshots: string[] = [];
  const stateEvidence: { label: string; db: DbEvidence }[] = [];
  const byMode: Partial<Record<Mode, number>> = {};
  const expectedHttp502: string[] = [];
  const held = new Set<ServerResponse>();
  const visualCases = (["light", "dark"] as const).flatMap((theme) =>
    [375, 768, 1440].flatMap((width) =>
      (["no-preference", "reduce"] as const).map((motion) => ({
        theme,
        width,
        motion,
      })),
    ),
  );
  const visualChecks = visualCases.map(
    (c) => `visual-${c.theme}-${c.width}-${c.motion}`,
  );
  const requiredChecks = [
    "isolated-setup",
    "wizard-contract",
    "manual-unknown-and-zero",
    "newapi-test-conversion-save-unknown",
    "token-scope-not-account-currency",
    "failed-custom-diagnostic-copy",
    ...visualChecks,
    "failed-custom-unverified-save",
    "zero-invalidation-platform-reset-cancel",
    "no-credential-unverified-save",
    "held-response-ui-and-session-busy",
    "deepseek-test-currency",
    "legacy-edit-unchanged",
    "final-idle-no-auto-query",
  ];
  const metrics = (): Metrics => ({
    provider: providerHits,
    draft: draftPosts,
    savedQuery: savedQueryRequests,
    creates: accountPosts,
  });
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Interrupted; clean all owned wizard resources"));
  const globalTimer = setTimeout(
    () =>
      abort.abort(
        new Error(`Global wizard verification timeout (${globalTimeoutMs}ms)`),
      ),
    globalTimeoutMs,
  );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const check = async (name: string, work: () => Promise<void>) => {
    if (abort.signal.aborted) throw abort.signal.reason;
    checkpoint = name;
    const before = metrics();
    try {
      await work();
      if (abort.signal.aborted) throw abort.signal.reason;
      checks.push({ name, status: "PASS", before, after: metrics() });
    } catch (e) {
      checks.push({ name, status: "FAIL", before, after: metrics() });
      throw e;
    }
  };
  const noQueries = async (label: string, work: () => Promise<void>) => {
    const before = metrics();
    await work();
    await pause(250); // Bounded negative observation; not an indefinite polling claim.
    const after = metrics();
    for (const key of ["provider", "draft", "savedQuery"] as const)
      assert.equal(
        after[key],
        before[key],
        label + " must not query/retry/poll: " + key,
      );
  };
  const fixture = createServer((req, res) => {
    providerHits++;
    res.setHeader("Content-Type", "application/json");
    const paths: Record<string, Mode> = {
      [prefix + "/account/api/user/self"]: "account",
      [prefix + "/token/api/usage/token"]: "token",
      [prefix + "/custom/401"]: "auth",
      [prefix + "/custom/wallet"]: "zero",
      [prefix + "/custom/hold"]: "hold",
      [prefix + "/deepseek/user/balance"]: "deepseek",
    };
    const mode = paths[req.url || ""];
    const auth = req.headers.authorization;
    const key = req.headers["x-api-key"];
    if (
      !mode ||
      req.method !== "GET" ||
      ![credential, changedCredential].some(
        (s) => auth === `Bearer ${s}` || key === s,
      ) ||
      (mode === "account" && req.headers["new-api-user"] !== userId) ||
      (mode === "token" && req.headers["new-api-user"] !== undefined)
    ) {
      fixtureErrors.push(
        "Unexpected provider method/path/auth/scope; fixture prefix must survive",
      );
      res.statusCode = 500;
      res.end('{"error":"fixture contract mismatch"}');
      return;
    }
    byMode[mode] = (byMode[mode] || 0) + 1;
    const privateFields = {
      credential,
      name: "FIXTURE · Wizard private account",
      domain: privateDomain,
      userId,
      body: credential,
    };
    if (mode === "auth") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "fixture rejected", ...privateFields }));
    } else if (mode === "account")
      res.end(
        JSON.stringify({
          success: true,
          data: { quota: "1000000" },
          ...privateFields,
        }),
      );
    else if (mode === "token")
      res.end(
        JSON.stringify({
          code: true,
          data: {
            total_available: "250000",
            unlimited_quota: false,
          },
          ...privateFields,
        }),
      );
    else if (mode === "zero")
      res.end(
        JSON.stringify({
          data: { amount: "900", used: "900" },
          ...privateFields,
        }),
      );
    else if (mode === "deepseek")
      res.end(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "12.25" },
            { currency: "USD", total_balance: "2.25" },
          ],
          ...privateFields,
        }),
      );
    else {
      held.add(res);
      res.once("close", () => held.delete(res));
    }
  });
  const releaseHeld = () => {
    for (const res of held)
      if (!res.destroyed)
        res.end(JSON.stringify({ data: { amount: "1250", used: "0" } }));
    held.clear();
  };

  const run = async () => {
    await check("isolated-setup", async () => {
      await requireFreePort();
      buildId = readFileSync(join(cwd, ".next", "BUILD_ID"), "utf8").trim();
      assert.ok(
        buildId,
        "An existing production build is required; this script never builds",
      );
      temp = mkdtempSync(join(tmpdir(), "atlas-wizard-ui-"));
      runtime = join(temp, "runtime");
      copyBuild(cwd, runtime, buildId);
      await new Promise<void>((ok, fail) => {
        fixture.once("error", fail);
        fixture.listen(0, "127.0.0.1", ok);
      });
      // No config or .env from the checkout is loaded by this child.
      server = spawn(
        process.execPath,
        [
          join(cwd, "node_modules/next/dist/bin/next"),
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: runtime,
          windowsHide: true,
          env: {
            ...cleanEnv(),
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            RELAYDOCK_DATA_DIR: join(temp, "data"),
            RELAYDOCK_ADMIN_PASSWORD_HASH: hashPassword(password),
            RELAYDOCK_ADMIN_PASSWORD: "",
            RELAYDOCK_VAULT_KEY: randomBytes(32).toString("hex"),
            RELAYDOCK_PUBLIC_URL: "",
            RELAYDOCK_PRIVATE_HOSTS: "localhost,127.0.0.1",
            RELAYDOCK_DNS_MODE: "system",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let spawnError: Error | undefined;
      server.once("error", (e) => {
        spawnError = e;
      });
      server.stdout!.on("data", (b) => {
        logs += redact(String(b));
      });
      server.stderr!.on("data", (b) => {
        logs += redact(String(b));
      });
      await until(
        async () => {
          if (spawnError) throw spawnError;
          assert.equal(
            server!.exitCode,
            null,
            "Isolated next start exited: " + logs,
          );
          assert.equal(
            server!.signalCode,
            null,
            "Isolated next start was interrupted",
          );
          if (!/Ready in/i.test(logs)) return false;
          try {
            return (
              await fetch(origin + "/api/auth/session", {
                signal: AbortSignal.timeout(1000),
              })
            ).ok;
          } catch {
            return false;
          }
        },
        "Isolated server not ready: " + logs,
        30_000,
      );
      browser = await chromium.launch({
        headless: true,
        env: cleanEnv() as Record<string, string>,
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        serviceWorkers: "block",
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin,
      });
      // Guard external browser networking, without mocking any app/provider endpoint.
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.origin === origin
        )
          await route.continue();
        else {
          errors.push("Unexpected external browser request: " + url.origin);
          await route.abort("blockedbyclient");
        }
      });
      page = await context.newPage();
      page.setDefaultTimeout(6000);
      page.setDefaultNavigationTimeout(15_000);
      page.on("pageerror", (e) => errors.push("pageerror: " + message(e)));
      page.on("request", (req) => {
        const url = new URL(req.url());
        if (url.origin !== origin) return;
        if (url.pathname === "/api/query/test" && req.method() === "POST")
          draftPosts++;
        if (/^\/api\/accounts\/[^/]+\/(?:test|sync)$/.test(url.pathname))
          savedQueryRequests++;
        if (url.pathname === "/api/accounts" && req.method() === "POST")
          accountPosts++;
        if ([credential, changedCredential].some((s) => req.url().includes(s)))
          errors.push("A fixture credential appeared in a request URL");
      });
      page.on("console", (entry) => {
        if (entry.type() !== "error") return;
        if (
          entry.location().url === origin + "/api/query/test" &&
          /^Failed to load resource: the server responded with a status of 502\b/.test(
            entry.text(),
          )
        )
          expectedHttp502.push(
            "POST /api/query/test 502 (real fixture failure)",
          );
        else errors.push("console.error: " + redact(entry.text()));
      });
      page.on("requestfailed", (req) => {
        const reason = req.failure()?.errorText || "unknown";
        if (!reason.includes("ERR_ABORTED"))
          errors.push(
            "requestfailed: " + new URL(req.url()).pathname + " " + reason,
          );
      });
      await page.goto(origin);
      await page.getByLabel("管理员密码", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "进入我的群岛", exact: true })
        .click();
      await page
        .getByRole("button", { name: "添加第一个站点", exact: true })
        .waitFor();
      assert.ok(existsSync(join(temp!, "data", "atlas.sqlite")));
      const db = dbSnapshot(temp!);
      assert.equal(db.accounts, 0);
      assert.equal(db.snapshots, 0);
      assert.equal(db.credentials, 0);
      stateEvidence.push({ label: "isolated empty database after login", db });
      assert.deepEqual(metrics(), {
        provider: 0,
        draft: 0,
        savedQuery: 0,
        creates: 0,
      });
      assert.equal(
        readFileSync(join(cwd, ".next/BUILD_ID"), "utf8").trim(),
        buildId,
      );
    });
    const view = page!,
      context = view.context();
    const sessionResponse = await context.request.get(
      origin + "/api/auth/session",
    );
    assert.equal(sessionResponse.status(), 200);
    const session = object(await sessionResponse.json(), "session");
    assert.equal(session.authenticated, true);
    assert.ok(typeof session.csrf === "string");
    const csrf = session.csrf as string;
    const api = async (
      path: string,
      method = "GET",
      data?: unknown,
      status = 200,
    ): Promise<Json> => {
      const response = await context.request.fetch(origin + "/api/" + path, {
        method,
        headers: { Origin: origin, "x-csrf-token": csrf },
        ...(data === undefined ? {} : { data }),
        timeout: 15_000,
      });
      assert.equal(response.status(), status, method + " " + path + " status");
      return object(await response.json(), "API response");
    };
    const state = async (label: string): Promise<State> => {
      const list = await api("accounts"),
        history = await api("history");
      assert.ok(Array.isArray(list.accounts));
      assert.ok(Array.isArray(history.snapshots));
      const db = dbSnapshot(temp!);
      assert.equal(list.accounts.length, db.accounts);
      assert.equal(history.snapshots.length, db.snapshots);
      stateEvidence.push({ label, db });
      return {
        accounts: list.accounts as Json[],
        snapshots: history.snapshots as Json[],
        db,
      };
    };
    const unchanged = async (before: State, label: string) =>
      assert.deepEqual(
        await state(label),
        before,
        label +
          " must not persist draft accounts/history/diagnostics/credentials/settings",
      );
    const dialog = () =>
      view.getByRole("dialog", { name: "添加一处站点", exact: true });
    const heading = (step: number) =>
      dialog().getByRole("heading", {
        name: headings[step - 1],
        exact: true,
        level: 3,
      });
    const at = async (step: number) => {
      await heading(step).waitFor();
    };
    const button = (name: string) =>
      dialog().getByRole("button", { name, exact: true });
    // Visible required marks belong to native labels; keep matching exact copy,
    // while accepting its optional trailing star (not arbitrary partial labels).
    const field = (name: string) =>
      dialog().getByLabel(
        new RegExp(
          "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:\\s*\\*)?$",
        ),
      );
    const progress = () =>
      dialog().getByRole("list", { name: "配置进度", exact: true });
    const backTo = async (step: number) => {
      await progress()
        .getByRole("button", { name: steps[step - 1], exact: true })
        .click();
      await at(step);
    };
    const next = async (from: number) => {
      await button("下一步").click();
      await at(from + 1);
    };
    const select = async (label: string, option: RegExp) => {
      const trigger = dialog().getByRole("combobox", {
        name: label,
        exact: true,
      });
      await trigger.waitFor();
      assert.equal(
        await trigger.evaluate((el) => el.tagName),
        "BUTTON",
        label + " must use AtlasSelect",
      );
      await trigger.click();
      await view.getByRole("option", { name: option }).click();
    };
    const open = async () => {
      const empty = view.getByRole("button", {
        name: "添加第一个站点",
        exact: true,
      });
      await (
        (await empty.isVisible())
          ? empty
          : view.getByRole("button", {
              name: "添加站点",
              exact: true,
            })
      ).click();
      await dialog().waitFor();
      await at(1);
    };
    const close = async () => {
      await dialog()
        .getByRole("button", { name: "关闭对话框", exact: true })
        .click();
      await dialog().waitFor({ state: "hidden" });
    };
    const choose = async (provider: Provider) => {
      const platform = platforms.find((p) => p.value === provider)!;
      const radio = dialog().getByRole("radio", {
        name: platform.label,
        exact: true,
      });
      await radio.check();
      assert.ok(await radio.isChecked());
    };
    const fillIdentity = async (
      name: string,
      root: string,
      alias = "fixture alias",
    ) => {
      await field("站点名称").fill(name);
      await field("网站地址").fill(root);
      await field("账号别名").fill(alias);
    };
    const begin = async (
      provider: Provider,
      name: string,
      root: string,
      managementUrl?: string,
      secret = credential,
    ) => {
      await open();
      await choose(provider);
      await next(1);
      await fillIdentity(name, root);
      if (provider !== "manual") {
        const platform = platforms.find((p) => p.value === provider)!;
        await field(platform.credential!).fill(secret);
        await field(
          provider === "newapi" ? "管理接口根地址" : "余额接口根地址",
        ).fill(managementUrl || root);
        await dialog().getByText("高级连接设置", { exact: true }).click();
        await dialog()
          .getByRole("combobox", { name: "查询超时", exact: true })
          .waitFor();
      }
    };
    const queryFields = async (path: string, timeout = 10) => {
      await field("GET 查询路径").fill(path);
      await field("余额字段路径").fill("data.amount");
      await field("扣减字段（可选）").fill("data.used");
      await field("结果除数").fill("100");
      await select("认证方式", /^x-api-key(?:\s|$)/);
      if (timeout !== 10)
        await select("查询超时", new RegExp(`^${timeout} 秒(?:\\s|$)`));
    };
    const blocked = async (name: string, step: number) => {
      const before = metrics();
      if (!(await button(name).isDisabled())) await button(name).click();
      await at(step);
      assert.equal(
        accountPosts,
        before.creates,
        "unconfirmed step cannot create an account",
      );
    };
    const confirmUnit = async () => {
      await at(4);
      await blocked("下一步", 4);
      await field("我已确认余额单位与查询口径").check();
      await next(4);
    };
    const confirmUnverified = async () => {
      await at(5);
      await blocked("保存站点", 5);
      const confirmation = field("我确认保存尚未验证的配置");
      assert.ok(!(await confirmation.isChecked()));
      await confirmation.check();
    };
    const storageIsPrivate = async () => {
      const stored = await view.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          url: location.href,
        }),
      );
      for (const secret of [credential, changedCredential])
        assert.ok(
          !stored.includes(secret),
          "draft credential must not enter browser storage/URL",
        );
    };
    const fixtureRoot = `http://localhost:${(fixture.address() as { port: number }).port}`;
    const draft = (
      provider: Draft["provider"],
      mode: "account" | "token" | "custom" | "deepseek",
      overrides: Partial<Draft> = {},
    ): Draft => ({
      provider,
      siteUrl: fixtureRoot,
      apiUrl: "",
      managementUrl: fixtureRoot + prefix + "/" + mode,
      userId: provider === "newapi" ? userId : "",
      query: { ...queryDefaults },
      unit: provider === "deepseek" ? "CNY" : "USD",
      quotaPerUnit: null,
      credential,
      ...overrides,
    });
    const customDraft = (
      path: string,
      timeoutSeconds = 10,
      secret = credential,
    ) =>
      draft("custom", "custom", {
        credential: secret,
        query: {
          ...queryDefaults,
          timeoutSeconds,
          path,
          balancePath: "data.amount",
          subtractPath: "data.used",
          divisor: "100",
          authHeader: "x-api-key",
        },
      });
    const assertDraft = (req: Request, expected: Draft) => {
      assert.equal(req.method(), "POST");
      assert.equal(req.headers().origin, origin);
      assert.equal(req.headers()["x-csrf-token"], csrf);
      const body = object(req.postDataJSON(), "draft POST body");
      keys(
        body,
        [...Object.keys(expected), "routeMode"],
        "draft accepts query fields only, no name/identity/test balance",
      );
      assert.deepEqual(
        body,
        { ...expected, routeMode: "direct" },
        "UI draft payload must match the independent API contract",
      );
    };
    const test = async (
      expected: Draft,
      balance: string,
      unit: string,
      rawQuota: string | null,
      code = "ok",
      during?: () => Promise<void>,
    ) => {
      const before = await state("before draft test " + expected.provider),
        counts = metrics();
      const waiting = view.waitForResponse(
        (r) =>
          r.url() === origin + "/api/query/test" &&
          r.request().method() === "POST",
        { timeout: 15_000 },
      );
      // Attach a rejection handler immediately; a missing UI must not leak a waiter.
      void waiting.catch(() => {});
      try {
        await button("测试连接").click();
        if (during) await during();
      } finally {
        releaseHeld();
      }
      const response = await waiting;
      assertDraft(response.request(), expected);
      assert.equal(response.status(), code === "ok" ? 200 : 502);
      const body = object(await response.json(), "draft response");
      keys(
        body,
        code === "ok"
          ? ["ok", "balance", "unit", "rawQuota", "diagnostic"]
          : ["error", "diagnostic"],
        "draft response whitelist",
      );
      if (code === "ok") {
        assert.equal(body.ok, true);
        assert.equal(body.balance, balance);
        assert.equal(body.unit, unit);
        assert.equal(body.rawQuota, rawQuota);
      } else assert.ok(typeof body.error === "string" && body.error.length > 0);
      const d = assertDiagnostic(
        body.diagnostic,
        expected.provider,
        code,
        code === "ok" ? 200 : 401,
        expected.query.timeoutSeconds,
      );
      assert.equal(
        providerHits,
        counts.provider + 1,
        "one explicit click -> one real provider GET",
      );
      assert.equal(
        draftPosts,
        counts.draft + 1,
        "one explicit click -> one draft POST, no retry",
      );
      assert.equal(savedQueryRequests, counts.savedQuery);
      assert.equal(accountPosts, counts.creates);
      await unchanged(before, "after draft test " + expected.provider);
      await storageIsPrivate();
      if (code === "ok") await button("继续确认单位").waitFor();
      return d;
    };
    const save = async (
      expected: Json,
      initialBalance: string | null = null,
    ) => {
      const before = await state("before explicit save"),
        counts = metrics();
      const waiting = view.waitForResponse(
        (r) =>
          r.url() === origin + "/api/accounts" &&
          r.request().method() === "POST",
      );
      void waiting.catch(() => {});
      await noQueries("saving configuration", async () => {
        await button("保存站点").click();
        const response = await waiting;
        assert.equal(
          response.status(),
          201,
          "explicit save is account CRUD, not a query",
        );
        const sent = object(
          response.request().postDataJSON(),
          "account save payload",
        );
        for (const key of [
          "balance",
          "rawQuota",
          "diagnostic",
          "lastQueryDiagnostic",
          "testResult",
          "testBalance",
        ])
          assert.ok(
            !Object.hasOwn(sent, key),
            "never submit a draft test result to account CRUD: " + key,
          );
        assert.equal(
          sent.initialBalance ?? null,
          initialBalance,
          "only explicit manual initial balance can be recorded",
        );
        await dialog().waitFor({ state: "hidden" });
      });
      assert.equal(
        accountPosts,
        counts.creates + 1,
        "one save creates exactly one account",
      );
      const after = await state("after explicit save");
      const added = after.accounts.filter(
        (a) => !before.accounts.some((old) => old.id === a.id),
      );
      assert.equal(added.length, 1);
      const account = added[0];
      for (const [key, value] of Object.entries(expected))
        assert.deepEqual(account[key], value, "saved " + key);
      assert.equal(account.balance, initialBalance);
      assert.equal(account.rawQuota, null);
      assert.equal(account.lastSyncStatus, "never");
      assert.equal(account.lastSyncAt, null);
      assert.equal(account.lastQueryDiagnostic ?? null, null);
      const history = await api(`accounts/${account.id}/history`);
      assert.ok(Array.isArray(history.snapshots));
      assert.equal(history.snapshots.length, initialBalance === null ? 0 : 1);
      if (initialBalance !== null) {
        const snapshot = object(
          history.snapshots[0],
          "manual initial snapshot",
        );
        assert.equal(snapshot.amount, initialBalance);
        assert.equal(snapshot.source, "manual");
        assert.equal(snapshot.rawQuota, null);
        assert.equal(snapshot.unit, account.unit);
      } else assert.equal(account.lastSnapshotAt, null);
      assert.deepEqual(
        after.accounts.filter((a) => a.id !== account.id),
        before.accounts,
        "save must not mutate other accounts",
      );
      assert.equal(after.db.accounts, before.db.accounts + 1);
      assert.equal(
        after.db.snapshots,
        before.db.snapshots + (initialBalance === null ? 0 : 1),
      );
      assert.equal(
        after.db.credentials,
        before.db.credentials + (account.hasCredential ? 1 : 0),
      );
      await storageIsPrivate();
      return account;
    };
    const capture = async (filename: string) => {
      await noOverflow(view);
      await screenshot(view, join(out, filename));
      screenshots.push(filename);
    };

    await check("wizard-contract", async () => {
      await view
        .getByRole("button", { name: "添加第一个站点", exact: true })
        .click();
      await dialog().waitFor();
      const list = dialog().locator('ol[aria-label="配置进度"]');
      if ((await list.count()) !== 1) {
        missingWizard = true;
        assert.fail(
          'RED: existing production UI has no ol[aria-label="配置进度"] in dialog “添加一处站点”; five-step add wizard is not present.',
        );
      }
      await at(1);
      assert.equal(await progress().count(), 1);
      assert.equal(await progress().getByRole("button").count(), 5);
      for (let i = 0; i < steps.length; i++) {
        const control = progress().getByRole("button", {
          name: steps[i],
          exact: true,
        });
        assert.equal(await control.count(), 1);
        if (i > 0)
          assert.ok(
            await control.isDisabled(),
            "unvisited steps cannot skip forwards",
          );
      }
      for (const platform of platforms)
        assert.equal(
          await dialog()
            .getByRole("radio", { name: platform.label, exact: true })
            .count(),
          1,
        );
      assert.ok(
        await dialog()
          .getByRole("radio", {
            name: platforms.find((p) => p.value === "manual")!.label,
            exact: true,
          })
          .isChecked(),
        "manual is the safe default; never infer a platform from a domain",
      );
      assert.equal(await dialog().getByRole("radio").count(), platforms.length);
      await capture("fixture-step-1-platform-light-1440.png");
      assert.deepEqual(metrics(), {
        provider: 0,
        draft: 0,
        savedQuery: 0,
        creates: 0,
      });
    });
    if (redOnly) return;

    // Theme changes in the screenshot matrix follow the real system-theme hook.
    // No CSS/DOM theme overrides and no repeated provider tests for visual variants.
    await close();
    await api("settings", "PATCH", {
      theme: "system",
      motion: true,
      mapBackground: "grid",
    });
    await view.emulateMedia({
      colorScheme: "light",
      reducedMotion: "no-preference",
    });
    await view.reload();
    await view
      .getByRole("button", { name: "添加第一个站点", exact: true })
      .waitFor();
    await check("manual-unknown-and-zero", async () => {
      await noQueries("manual wizard and explicit zero", async () => {
        await begin("manual", "FIXTURE · Wizard manual unknown", fixtureRoot);
        await button("上一步").click();
        await at(1);
        await next(1);
        assert.equal(
          await field("站点名称").inputValue(),
          "FIXTURE · Wizard manual unknown",
        );
        assert.equal(await field("网站地址").inputValue(), fixtureRoot);
        assert.equal(await field("账号别名").inputValue(), "fixture alias");
        await field("账号别名").press("Enter");
        if (!(await heading(2).isVisible())) await backTo(2);
        assert.equal(
          accountPosts,
          0,
          "Enter in draft metadata must not save/query",
        );
        await capture("fixture-step-2-fields-light-1440.png");
        await next(2);
        assert.equal(
          await button("测试连接").count(),
          0,
          "manual cannot query any provider",
        );
        await button("继续确认单位").click();
        await at(4);
        await dialog()
          .getByRole("combobox", { name: "余额单位", exact: true })
          .click();
        for (const choice of [
          /^USD(?:\s|$)/,
          /^CNY(?:\s|$)/,
          /^自定义单位(?:\s|$)/,
        ])
          assert.equal(
            await view.getByRole("option", { name: choice }).count(),
            1,
          );
        await view.keyboard.press("Escape");
        assert.equal(await field("初始余额（可选）").inputValue(), "");
        await confirmUnit();
        await field("分组").click();
        await view.getByRole("option", { name: /^新建分组/ }).click();
        await field("新分组名称").fill("Fixture group");
        await field("标签").fill("fixture,unknown");
        await field("低余额阈值（可选）").fill("1.25");
        assert.equal(
          await field("我确认保存尚未验证的配置").count(),
          0,
          "manual does not require an API test",
        );
        await save({
          provider: "manual",
          name: "FIXTURE · Wizard manual unknown",
          hasCredential: false,
          group: "Fixture group",
          tags: ["fixture", "unknown"],
          lowThreshold: "1.25",
          unit: "USD",
        });
        await begin("manual", "FIXTURE · Wizard manual zero", fixtureRoot);
        await next(2);
        await button("继续确认单位").click();
        await at(4);
        await select("余额单位", /^CNY(?:\s|$)/);
        await field("初始余额（可选）").fill("0");
        await confirmUnit();
        assert.equal(
          await field("我确认保存尚未验证的配置").count(),
          0,
          "manual zero does not require an API test",
        );
        await save(
          {
            provider: "manual",
            name: "FIXTURE · Wizard manual zero",
            unit: "CNY",
            hasCredential: false,
            balanceUnit: "CNY",
          },
          "0",
        );
      });
    });
    let newapiAccount: Json | undefined;
    await check("newapi-test-conversion-save-unknown", async () => {
      await noQueries("entering New API draft and pressing Enter", async () => {
        await begin(
          "newapi",
          "FIXTURE · Wizard account",
          fixtureRoot,
          draft("newapi", "account").managementUrl,
        );
        await field("用户 ID（站点要求时必填）").fill(userId);
        await field("用户管理令牌").press("Enter");
        if (!(await heading(2).isVisible())) await backTo(2);
        await next(2);
      });
      await test(draft("newapi", "account"), "1000000", "配额", "1000000");
      await noQueries(
        "raw quota conversion and non-query metadata edits",
        async () => {
          await button("继续确认单位").click();
          await at(4);
          assert.match(
            (await dialog().innerText()).replace(/[,，\s]/g, ""),
            /1000000/,
          );
          assert.match(await dialog().innerText(), /原始配额|配额/);
          const conversion = field("我已确认换算系数");
          assert.ok(!(await conversion.isChecked()));
          await conversion.check();
          await field("每单位对应的原始配额").fill("400000");
          await until(
            async () => /2\.5(?:0*)\b/.test(await dialog().innerText()),
            "real rawQuota / 400000 must preview 2.5 without another provider request",
          );
          assert.match(await dialog().innerText(), /USD/);
          await capture("fixture-step-4-raw-quota-conversion-light-1440.png");
          await field("每单位对应的原始配额").fill("500000");
          await backTo(2);
          assert.equal(await field("用户管理令牌").inputValue(), credential);
          assert.equal(
            await field("管理接口根地址").inputValue(),
            draft("newapi", "account").managementUrl,
          );
          await field("账号别名").fill("metadata edit keeps the test");
          await field("站点名称").fill("FIXTURE · Wizard account saved");
          await next(2);
          await button("继续确认单位").waitFor();
          await button("继续确认单位").click();
          await at(4);
          assert.equal(
            await field("每单位对应的原始配额").inputValue(),
            "500000",
          );
          await confirmUnit();
          await field("分组").click();
          await view.getByRole("option", { name: /^新建分组/ }).click();
          await field("新分组名称").fill("Fixture account group");
          await field("标签").fill("fixture,newapi");
          const warning = field("我确认保存尚未验证的配置");
          assert.ok(
            !(await warning.isVisible()),
            "an unchanged successful test is still verified",
          );
          await capture("fixture-step-5-save-light-1440.png");
        },
      );
      newapiAccount = await save({
        provider: "newapi",
        name: "FIXTURE · Wizard account saved",
        alias: "metadata edit keeps the test",
        group: "Fixture account group",
        tags: ["fixture", "newapi"],
        unit: "USD",
        quotaPerUnit: "500000",
        hasCredential: true,
      });
    });
    await check("token-scope-not-account-currency", async () => {
      await noQueries(
        "entering token draft on the same fixture host",
        async () => {
          await begin(
            "newapi-token",
            "FIXTURE · Wizard single token",
            fixtureRoot,
            draft("newapi-token", "token").managementUrl,
          );
          await next(2);
        },
      );
      await test(
        draft("newapi-token", "token"),
        "250000",
        "令牌配额",
        "250000",
      );
      assert.equal(byMode.token, 1);
      assert.equal(
        byMode.account,
        1,
        "a model API Key must not hit the account-management endpoint",
      );
      await noQueries("token scope confirmation", async () => {
        await button("继续确认单位").click();
        await at(4);
        assert.match(await dialog().innerText(), /令牌/);
        await confirmUnit();
      });
      await save({
        provider: "newapi-token",
        quotaPerUnit: null,
        hasCredential: true,
      });
      await noQueries(
        "token currency filter must remain scope-specific",
        async () => {
          await view
            .getByRole("combobox", { name: "筛选币种", exact: true })
            .click();
          assert.ok(
            (await view.getByRole("option", { name: /令牌/ }).count()) >= 1,
            "token units cannot silently join ordinary USD/CNY account currency filters",
          );
          await view.keyboard.press("Escape");
        },
      );
    });
    let failedDiagnostic: Json | undefined;
    await check("failed-custom-diagnostic-copy", async () => {
      await noQueries(
        "custom mappings, AtlasSelect auth/timeout and step back",
        async () => {
          await begin(
            "custom",
            "FIXTURE · Wizard rejected",
            fixtureRoot,
            customDraft("/401", 20).managementUrl,
          );
          await queryFields("/401", 20);
          await next(2);
          await button("上一步").click();
          await at(2);
          assert.equal(await field("GET 查询路径").inputValue(), "/401");
          assert.equal(await field("结果除数").inputValue(), "100");
          await dialog().getByText("高级连接设置", { exact: true }).click();
          assert.match(
            await dialog()
              .getByRole("combobox", { name: "查询超时", exact: true })
              .innerText(),
            /20/,
          );
          await next(2);
        },
      );
      failedDiagnostic = await test(
        customDraft("/401", 20),
        "",
        "",
        null,
        "http_auth",
      );
      await noQueries("failure disclosure/copy", async () => {
        const region = dialog().getByRole("region", {
          name: "查询诊断",
          exact: true,
        });
        await region.waitFor();
        const details = (await region.evaluate(
          (el) => el instanceof HTMLDetailsElement,
        ))
          ? region
          : region.locator("details");
        assert.equal(await details.count(), 1);
        assert.ok(
          await details.evaluate((el) => (el as HTMLDetailsElement).open),
          "failure diagnostic opens so the user can repair or explicitly save unverified",
        );
        assert.match(await region.innerText(), /401/);
        await view.evaluate(() =>
          navigator.clipboard.writeText("fixture clipboard sentinel"),
        );
        await region
          .getByRole("button", { name: "复制脱敏报告", exact: true })
          .click();
        await view.waitForFunction(
          async () =>
            (await navigator.clipboard.readText()) !==
            "fixture clipboard sentinel",
        );
        const copied = await view.evaluate(() =>
          navigator.clipboard.readText(),
        );
        assert.deepEqual(
          assertDiagnostic(JSON.parse(copied), "custom", "http_auth", 401, 20),
          failedDiagnostic,
        );
        await region.locator("summary").click();
        await region.locator("summary").click();
      });
    });
    // Twelve visual variants of ONE real failed draft: no provider/UI/network mock,
    // no repeat diagnostic matrix. Other screenshots cover the remaining steps.
    for (const c of visualCases)
      await check(`visual-${c.theme}-${c.width}-${c.motion}`, async () => {
        const before = await state("before visual variant");
        await noQueries("viewport/system theme/reduced motion", async () => {
          await view.setViewportSize({
            width: c.width,
            height: c.width === 375 ? 812 : 960,
          });
          await view.emulateMedia({
            colorScheme: c.theme,
            reducedMotion: c.motion,
          });
          await until(
            () =>
              view.evaluate(
                (theme) => document.documentElement.dataset.theme === theme,
                c.theme,
              ),
            "real theme hook did not update",
          );
          assert.equal(
            await view.evaluate(
              () => matchMedia("(prefers-reduced-motion: reduce)").matches,
            ),
            c.motion === "reduce",
          );
          await pause(100);
          await capture(
            `fixture-step-3-diagnostic-${c.theme}-${c.width}-${c.motion}.png`,
          );
        });
        await unchanged(
          before,
          "visual variant has no persistence side effects",
        );
      });
    await check("failed-custom-unverified-save", async () => {
      await noQueries(
        "skipping failed test and explicit unverified acknowledgement",
        async () => {
          await button("暂不测试，继续").click();
          await at(4);
          await confirmUnit();
          await confirmUnverified();
        },
      );
      await save({
        provider: "custom",
        name: "FIXTURE · Wizard rejected",
        hasCredential: true,
        query: customDraft("/401", 20).query,
      });
      await view.setViewportSize({ width: 1440, height: 960 });
      await view.emulateMedia({
        colorScheme: "light",
        reducedMotion: "no-preference",
      });
    });
    await check("zero-invalidation-platform-reset-cancel", async () => {
      const original = await state("before cancellable zero draft");
      await noQueries("configuring a zero-balance custom draft", async () => {
        await begin(
          "custom",
          "FIXTURE · Wizard canceled",
          fixtureRoot,
          customDraft("/wallet").managementUrl,
        );
        await queryFields("/wallet");
        await next(2);
      });
      await test(customDraft("/wallet"), "0", "USD", null);
      assert.match(
        await dialog().innerText(),
        /(?:\b0(?:\.0+)?\b|零)/,
        "a successful zero test is not an unknown balance",
      );
      const assertInvalidated = async () => {
        await next(2);
        assert.equal(
          await button("继续确认单位").count(),
          0,
          "changed query cannot reuse prior success",
        );
        const emptyDiagnostic = dialog().getByRole("region", {
          name: "查询诊断",
          exact: true,
        });
        assert.match(await emptyDiagnostic.innerText(), /尚无结果/);
        assert.equal(
          await dialog().locator(".wizard-test-result").count(),
          0,
          "changed query clears its prior successful balance preview",
        );
        await emptyDiagnostic.locator("summary").click();
        assert.equal(
          await emptyDiagnostic
            .getByRole("button", { name: "复制脱敏报告", exact: true })
            .count(),
          0,
          "no stale report can be copied after changing query fields",
        );
        await button("暂不测试，继续").waitFor();
      };
      await noQueries("credential edit invalidates success", async () => {
        await backTo(2);
        await field("查询密钥").fill(changedCredential);
        await assertInvalidated();
      });
      await test(
        customDraft("/wallet", 10, changedCredential),
        "0",
        "USD",
        null,
      );
      await noQueries(
        "query path edit and platform change clear sensitive query fields",
        async () => {
          await backTo(2);
          await field("GET 查询路径").fill("/401");
          await assertInvalidated();
          await backTo(1);
          await choose("newapi");
          await next(1);
          assert.equal(await field("用户管理令牌").inputValue(), "");
          assert.equal(await field("管理接口根地址").inputValue(), "");
          assert.equal(
            await field("站点名称").inputValue(),
            "FIXTURE · Wizard canceled",
          );
          assert.equal(await field("网站地址").inputValue(), fixtureRoot);
          assert.equal(await field("账号别名").inputValue(), "fixture alias");
          await close();
          await open();
          assert.ok(
            await dialog()
              .getByRole("radio", { name: "手动记录", exact: true })
              .isChecked(),
          );
          await next(1);
          assert.equal(await field("站点名称").inputValue(), "");
          assert.equal(await field("网站地址").inputValue(), "");
          await close();
        },
      );
      await unchanged(
        original,
        "cancel, edit and platform switch leave no draft DB/credential/history rows",
      );
      await storageIsPrivate();
    });
    await check("no-credential-unverified-save", async () => {
      await noQueries(
        "saving without credentials or a forced test",
        async () => {
          await begin(
            "newapi",
            "FIXTURE · Wizard no credential",
            fixtureRoot,
            draft("newapi", "account").managementUrl,
            "",
          );
          await next(2);
          await button("暂不测试，继续").click();
          await at(4);
          await confirmUnit();
          await confirmUnverified();
          await save({
            provider: "newapi",
            name: "FIXTURE · Wizard no credential",
            hasCredential: false,
            quotaPerUnit: null,
          });
        },
      );
    });
    await check("held-response-ui-and-session-busy", async () => {
      const before = await state("before held response draft");
      await noQueries("configuring held response", async () => {
        await begin(
          "custom",
          "FIXTURE · Wizard pending",
          fixtureRoot,
          customDraft("/hold").managementUrl,
        );
        await queryFields("/hold");
        await next(2);
      });
      const box = await button("测试连接").boundingBox();
      assert.ok(box);
      await test(customDraft("/hold"), "12.5", "USD", null, "ok", async () => {
        await until(
          () => held.size === 1,
          "real provider has not received held GET",
        );
        const counts = metrics();
        const busy = dialog().getByRole("button", {
          name: /测试连接|正在测试|测试中/,
        });
        assert.equal(await busy.count(), 1);
        assert.ok(await busy.isDisabled());
        assert.ok(
          await dialog()
            .getByRole("button", { name: "关闭对话框" })
            .isDisabled(),
        );
        await view.keyboard.press("Escape");
        assert.ok(
          await dialog().isVisible(),
          "Escape cannot dismiss an in-flight query",
        );
        await view.mouse.click(2, 2);
        assert.ok(
          await dialog().isVisible(),
          "Outside click cannot dismiss an in-flight query",
        );
        // Real pointer events on the disabled button, not forced DOM dispatch.
        await view.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
          clickCount: 2,
        });
        await pause(300);
        assert.deepEqual(
          metrics(),
          counts,
          "repeated click while pending must not fan out",
        );
        apiBusyProbes++;
        const conflict = await api(
          "query/test",
          "POST",
          customDraft("/hold"),
          409,
        );
        assert.ok(typeof conflict.error === "string");
        assert.equal(held.size, 1);
        assert.deepEqual(
          metrics(),
          counts,
          "session busy guard must reject duplicate HTTP query before provider work",
        );
        await unchanged(
          before,
          "held and rejected duplicate draft queries do not persist",
        );
      });
      await noQueries("closing completed held draft", close);
      await unchanged(
        before,
        "closing held draft never records its test balance",
      );
    });
    await check("deepseek-test-currency", async () => {
      const before = await state("before DeepSeek currency draft");
      await noQueries("DeepSeek test currency AtlasSelect", async () => {
        await begin(
          "deepseek",
          "FIXTURE · Wizard currency",
          fixtureRoot,
          draft("deepseek", "deepseek").managementUrl,
        );
        await select("测试币种", /^USD(?:\s|$)/);
        await next(2);
      });
      await test(
        draft("deepseek", "deepseek", { unit: "USD" }),
        "2.25",
        "USD",
        null,
      );
      await noQueries(
        "DeepSeek unit matches selected query currency",
        async () => {
          await button("继续确认单位").click();
          await at(4);
          assert.match(
            await dialog()
              .getByRole("combobox", { name: "余额单位", exact: true })
              .innerText(),
            /USD/,
          );
          await close();
        },
      );
      await unchanged(
        before,
        "DeepSeek currency draft canceled without persistence",
      );
    });
    await check("legacy-edit-unchanged", async () => {
      assert.ok(newapiAccount);
      const before = await state("before legacy edit");
      await noQueries("opening and closing legacy edit", async () => {
        await view
          .getByRole("button", { name: "列表视图", exact: true })
          .click();
        await view
          .getByRole("button", {
            name: `查看 ${newapiAccount!.name}`,
            exact: true,
          })
          .click();
        await view
          .locator(".account-detail")
          .getByRole("button", { name: "编辑档案", exact: true })
          .click();
        const edit = view.getByRole("dialog");
        await edit.waitFor();
        assert.equal(
          await edit.locator('ol[aria-label="配置进度"]').count(),
          0,
        );
        await edit
          .getByRole("combobox", { name: "记录方式", exact: true })
          .waitFor();
        await edit
          .getByRole("button", { name: "关闭对话框", exact: true })
          .click();
        await edit.waitFor({ state: "hidden" });
      });
      await unchanged(
        before,
        "legacy edit does not reset or query saved configuration",
      );
    });
    await check("final-idle-no-auto-query", async () => {
      const before = await state("before final navigation/idle");
      await noQueries("refresh, view changes and 1.2s idle", async () => {
        await view.reload();
        await view
          .getByRole("button", { name: "添加站点", exact: true })
          .waitFor();
        await view
          .getByRole("button", { name: "地图视图", exact: true })
          .click();
        await view
          .getByRole("button", { name: "列表视图", exact: true })
          .click();
        await pause(1200);
      });
      await unchanged(
        before,
        "navigation and idle never query or persist balances",
      );
      assert.equal(
        savedQueryRequests,
        0,
        "wizard must not use saved-account sync/test or auto-poll",
      );
      assert.deepEqual(byMode, {
        account: 1,
        token: 1,
        auth: 1,
        zero: 2,
        hold: 1,
        deepseek: 1,
      });
      assert.equal(draftPosts, 7);
      assert.equal(providerHits, 7);
      assert.equal(apiBusyProbes, 1);
      assert.equal(accountPosts, 6);
      assert.equal(before.snapshots.length, 1);
      assert.equal(before.db.credentials, 3);
      assert.deepEqual(fixtureErrors, []);
      assert.deepEqual(errors, []);
      assert.equal(
        readFileSync(join(cwd, ".next/BUILD_ID"), "utf8").trim(),
        buildId,
        "Production build changed mid-run; rerun against a stable main-thread build",
      );
    });
  };
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) =>
        abort.signal.addEventListener(
          "abort",
          () => reject(abort.signal.reason),
          { once: true },
        ),
      ),
    ]);
  } catch (e) {
    failure = e;
    abort.abort(e);
    if (page && !page.isClosed()) {
      await deadline(
        screenshot(page, join(out, "failure-fixture.png")),
        4000,
        "failure screenshot timeout",
      )
        .then(() => screenshots.push("failure-fixture.png"))
        .catch(() => {});
      await deadline(page.content(), 2000, "failure DOM timeout")
        .then((dom) => writeFileSync(join(out, "failure-dom.txt"), redact(dom)))
        .catch(() => {});
      await deadline(
        page.locator("body").ariaSnapshot(),
        2000,
        "failure aria timeout",
      )
        .then((aria) =>
          writeFileSync(join(out, "failure-aria.txt"), redact(aria)),
        )
        .catch(() => {});
    }
  } finally {
    clearTimeout(globalTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const clean = async (label: string, work: () => void | Promise<void>) => {
      try {
        await work();
      } catch (e) {
        cleanupErrors.push(label + ": " + message(e));
      }
    };
    await clean("browser", async () => {
      if (browser)
        await deadline(browser.close(), 7000, "browser close timeout");
      browserClosed = true;
    });
    await clean("owned next start", async () => {
      await stopOwnedServer(server);
      childStopped = true;
    });
    releaseHeld();
    await clean("HTTP fixture", async () => {
      fixture.closeAllConnections();
      if (fixture.listening)
        await deadline(
          new Promise<void>((ok, fail) =>
            fixture.close((e) => (e ? fail(e) : ok())),
          ),
          5000,
          "fixture close timeout",
        );
      fixtureClosed = true;
    });
    await clean("production build identity", () => {
      if (buildId) {
        buildUnchanged =
          readFileSync(join(cwd, ".next/BUILD_ID"), "utf8").trim() === buildId;
        assert.ok(
          buildUnchanged,
          "Production build changed during verification",
        );
      }
    });
    await clean("temporary runtime/SQLite", () => {
      if (!temp) {
        temporaryFilesRemoved = true;
        return;
      }
      assert.ok(
        childStopped,
        "Keep temporary files if the owned server could not be stopped",
      );
      // Validate resolved absolute targets before single-runtime native removal.
      const target = realpathSync(temp),
        expectedParent = realpathSync(tmpdir());
      assert.equal(dirname(target), expectedParent);
      assert.ok(basename(target).startsWith("atlas-wizard-ui-"));
      assert.notEqual(target, cwd);
      assert.notEqual(target, resolve(cwd, "data"));
      const link = join(target, "runtime", "node_modules");
      const linkRelative = relative(target, link);
      assert.ok(
        linkRelative &&
          !linkRelative.startsWith(".." + sep) &&
          !linkRelative.startsWith(sep),
      );
      if (existsSync(link)) {
        assert.ok(
          lstatSync(link).isSymbolicLink(),
          "Only remove our owned dependency junction, never installed packages",
        );
        unlinkSync(link);
      }
      rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      temporaryFilesRemoved = !existsSync(target);
      assert.ok(temporaryFilesRemoved);
    });
    writeFileSync(join(out, "server-log.txt"), redact(logs));
    const status = cleanupErrors.length
      ? "ERROR"
      : failure
        ? missingWizard
          ? "RED"
          : "FAIL"
        : redOnly
          ? "SMOKE_PASS"
          : "PASS";
    const report = {
      status,
      checkpoint,
      runId,
      buildId,
      buildUnchanged,
      port,
      childPid: server?.pid,
      checks,
      notRun: requiredChecks.filter(
        (name) => !checks.some((c) => c.name === name),
      ),
      requestCounts: { ...metrics(), apiBusyProbes, byMode },
      stateEvidence,
      screenshots,
      errors,
      fixtureErrors,
      expectedHttp502,
      cleanupErrors,
      existingBuildOnly: true,
      isolatedRuntimeWithoutEnvFiles: true,
      isolatedDatabase: true,
      systemDns: true,
      dohEnabled: false,
      privateHostAllowlist: ["localhost", "127.0.0.1"],
      temporaryFilesRemoved,
      childStopped,
      browserClosed,
      fixtureClosed,
      fixtureAmountsOnly: true,
      realProviderVerified: false,
      fullAcceptanceExecuted: !redOnly && !failure,
      greenExecuted: status === "PASS",
      globalTimeoutMs,
      negativeObservationMs: 250,
      finalIdleObservationMs: 1200,
      failure: failure ? message(failure) : null,
    };
    writeFileSync(
      join(out, "verification.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          status,
          checkpoint,
          buildId,
          port,
          requestCounts: report.requestCounts,
          cleanupErrors,
          temporaryFilesRemoved,
          childStopped,
          browserClosed,
          fixtureClosed,
          artifacts: out,
        },
        null,
        2,
      ),
    );
  }
  if (failure) throw failure;
  assert.deepEqual(
    cleanupErrors,
    [],
    "All owned wizard resources must be cleaned",
  );
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.stack || e.message : String(e)));
  process.exitCode = 1;
});
