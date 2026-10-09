import { assertDiagnosticFeatures, diagnosticFailureCases, diagnosticFailureBody } from "./diagnostic-feature-contract";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { hashPassword } from "../src/lib/crypto";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

// Standalone acceptance script. Uses the existing build; never builds or uses :3000.
// Run from relaydock: node node_modules/tsx/dist/cli.mjs scripts/verify-diagnostics.ts
// --red-only: first browser-sync/UI contract only; never claims full GREEN.
// --skip-timeouts: omit the two real 10s API timeout cases; reports the coverage gap.
// ATLAS_DIAGNOSTIC_PORT defaults to 3320, with a dynamic fallback if occupied.
const secret = "fixture-private-secret";
const password = "fixture-diagnostics-password-123";
const accountName = "Fixture 金额 · 诊断私有账号";
const userId = "24681357";
const prefix = "/fixture-private-prefix";
const initialBalance = "88.125",
  fixtureBalance = "30.25",
  fixtureQuota = "15125000";
const stageIds = ["dns", "connect", "response", "read", "parse"] as const;
const stageNames = ["DNS 解析", "建立连接", "等待响应", "读取响应", "余额解析"];
// Independent oracle: do not import the serializer/explanation being tested.
const codeCategories = {
  ok: "success",
  dns_failed: "network",
  dns_timeout: "network",
  connect_failed: "network",
  connect_timeout: "network",
  tls_error: "network",
  response_timeout: "network",
  response_failed: "network",
  read_failed: "network",
  read_timeout: "network",
  http_auth: "auth",
  http_missing: "compatibility",
  http_redirect: "compatibility",
  http_limited: "rate-limit",
  http_error: "service",
  provider_rejected: "service",
  invalid_json: "compatibility",
  response_html: "compatibility",
  response_too_large: "compatibility",
  invalid_balance: "compatibility",
  unsafe_target: "security",
  invalid_config: "configuration",
  missing_credential: "configuration",
  query_failed: "service",
} as const;
type Code = keyof typeof codeCategories;
type Action = "sync" | "test";
type Mode =
  | "success"
  | "auth"
  | "missing"
  | "invalid-json"
  | "html"
  | "no-quota"
  | "pending"
  | "response-stall"
  | "read-stall";
type Diagnostic = {
  schemaVersion: 1;
  provider: "newapi";
  operation: Action;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  timeoutSeconds: 10;
  dnsMode: "system";
  outcome: "success" | "failure";
  category: (typeof codeCategories)[Code];
  code: Code;
  httpStatus: number | null;
  stages: {
    id: (typeof stageIds)[number];
    status: "success" | "error" | "skipped" | "not-run";
    durationMs: number | null;
  }[];
};
type FixtureAccount = {
  id: string;
  balance: string | null;
  balanceUnit: string;
  rawQuota: string | null;
  lastSnapshotAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string;
  lastSyncError: string | null;
  lastQueryDiagnostic?: unknown;
};
type State = { account: FixtureAccount; snapshots: unknown[] };
type Check = {
  name: string;
  status: "PASS" | "FAIL";
  providerRequests: number;
};
const categoryTitles = {
  success: "查询链路正常",
  network: "网络连接问题",
  auth: "令牌或权限问题",
  compatibility: "接口或响应不兼容",
  "rate-limit": "站点请求限流",
  service: "站点拒绝或服务异常",
  security: "请求被安全规则拦截",
  configuration: "查询配置未完成",
};
const hints: Partial<Record<Code, string>> = {
  http_auth:
    "HTTP 401/403 可能是密钥、查询权限或站点防护拒绝。核对所选查询口径：账户管理令牌、用户 ID 或 Management Key。",
  http_missing:
    "核对平台模板与最终管理接口根地址；站点可能未开放此余额接口。不要只填聊天接口 /v1。",
  invalid_json:
    "响应解码后仍不是合法 JSON，余额字段提取尚未开始。对照 CC Switch 的完整接口路径、请求特征和查询线路；不能仅凭此错误归因于 New API 版本。",
  response_html:
    "收到的是 HTML 网页，不是余额 JSON。可能是登录页、首页兜底或网关页面；先对照实际接口和线路，而不是修改余额字段。",
  invalid_balance:
    "JSON 已读取，但不能按当前模板确认余额。检查字段、币种、账户/令牌口径及换算系数；没有猜测余额。",
};
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function object(input: unknown, label: string): Record<string, unknown> {
  assert.ok(
    input && typeof input === "object" && !Array.isArray(input),
    label + " must be an object",
  );
  return input as Record<string, unknown>;
}
function keys(
  input: Record<string, unknown>,
  expected: string[],
  label: string,
) {
  assert.deepEqual(
    Object.keys(input).sort(),
    [...expected].sort(),
    label + " must contain only the contract whitelist",
  );
}
function finiteMs(input: unknown, label: string) {
  assert.ok(
    typeof input === "number" &&
      Number.isFinite(input) &&
      input >= 0 &&
      input <= 3600000,
    label + " must be measured finite milliseconds",
  );
}
function diagnostic(
  input: unknown,
  action: Action,
  code: Code,
  httpStatus: number | null,
  id: string,
): Diagnostic {
  const d = object(input, "diagnostic");
  keys(
    d,
    [
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
      ...assertDiagnosticFeatures(d),
    ],
    "diagnostic",
  );
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.provider, "newapi");
  assert.equal(d.operation, action);
  assert.equal(d.timeoutSeconds, 10);
  assert.equal(d.dnsMode, "system");
  assert.ok(
    typeof d.code === "string" && Object.hasOwn(codeCategories, d.code),
    "code must be fixed, never upstream free text",
  );
  assert.equal(d.code, code);
  assert.equal(d.category, codeCategories[code]);
  assert.equal(d.outcome, code === "ok" ? "success" : "failure");
  assert.equal(d.httpStatus, httpStatus);
  for (const field of ["startedAt", "finishedAt"] as const) {
    assert.ok(
      typeof d[field] === "string" &&
        /^\d{4}-\d{2}-\d{2}T.*Z$/.test(d[field]) &&
        Number.isFinite(Date.parse(d[field])),
      field + " must be an ISO timestamp",
    );
  }
  assert.ok(
    Date.parse(d.finishedAt as string) >= Date.parse(d.startedAt as string),
  );
  finiteMs(d.totalMs, "totalMs");
  assert.ok(Array.isArray(d.stages));
  assert.equal(d.stages.length, 5);
  d.stages.forEach((input, i) => {
    const s = object(input, "stage");
    keys(s, ["id", "status", "durationMs"], "stage");
    assert.equal(s.id, stageIds[i]);
    assert.ok(
      ["success", "error", "skipped", "not-run"].includes(String(s.status)),
    );
    if (s.status === "not-run")
      assert.equal(
        s.durationMs,
        null,
        "unexecuted stages must not have fabricated 0 ms",
      );
    else if (s.status === "skipped")
      assert.equal(
        s.durationMs,
        0,
        "the API's IP-literal DNS skip marker is not a measured UI duration",
      );
    else finiteMs(s.durationMs, "stage.durationMs");
  });
  const result = input as Diagnostic;
  assert.ok(
    result.stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) <=
      result.totalMs + 1,
    "stage measurements must fit the measured total (rounding tolerance 1ms)",
  );
  if (code === "ok")
    assert.ok(
      result.stages.every(
        (s) =>
          s.status === "success" || (s.id === "dns" && s.status === "skipped"),
      ),
    );
  else
    assert.ok(
      result.stages.some((s) => s.status === "error"),
      "a real fixture failure must mark its active stage",
    );
  if (["http_auth", "http_missing"].includes(code))
    assert.deepEqual(result.stages[4], {
      id: "parse",
      status: "not-run",
      durationMs: null,
    });
  if (code === "invalid_balance")
    assert.equal(result.stages[4].status, "error");
  const report = JSON.stringify(result);
  for (const forbidden of [
    secret,
    accountName,
    id,
    userId,
    "localhost",
    "127.0.0.1",
    prefix,
    '"balance":',
    '"quota":',
    '"rawQuota":',
    '"headers":',
    '"body":',
    JSON.stringify(initialBalance),
    JSON.stringify(fixtureBalance),
    JSON.stringify(fixtureQuota),
  ]) {
    assert.ok(
      !report.includes(forbidden),
      "diagnostic contains private fixture material: " + forbidden,
    );
  }
  return result;
}
function unchanged(before: State, after: State, action: Action) {
  assert.deepEqual(
    after.snapshots,
    before.snapshots,
    "tests and failed syncs must not add/change history snapshots",
  );
  for (const key of [
    "balance",
    "balanceUnit",
    "rawQuota",
    "lastSnapshotAt",
  ] as const)
    assert.equal(
      after.account[key],
      before.account[key],
      key + " must survive a test/failed sync",
    );
  if (action === "test") {
    for (const key of [
      "lastSyncAt",
      "lastSyncStatus",
      "lastSyncError",
    ] as const)
      assert.equal(
        after.account[key],
        before.account[key],
        "test must not impersonate sync: " + key,
      );
  }
}

async function until(
  condition: () => Promise<boolean> | boolean,
  label: string,
  timeout = 6000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await pause(50);
  }
  assert.fail(label);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopOwnedServer(server: ReturnType<typeof spawn> | undefined) {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null)
    return;
  const exited = new Promise<void>((r) => server.once("exit", () => r()));
  server.kill(); // No taskkill, port-owner kill, shell commands, or shared process trees.
  try {
    await withDeadline(exited, 5000, "Owned next start did not exit");
  } catch {
    server.kill("SIGKILL");
    await withDeadline(
      exited,
      5000,
      "Owned next start could not be stopped; temp database retained",
    );
  }
}

async function screenshot(page: Page, filename: string) {
  // Caption applies only to the artifact, not production UI or layout assertions.
  await page.evaluate(() => {
    const caption = document.createElement("div");
    caption.id = "diagnostics-fixture-caption";
    caption.textContent = "FIXTURE · 截图余额来自隔离夹具，非真实账户";
    caption.style.cssText =
      "position:fixed;bottom:4px;left:4px;z-index:2147483647;max-width:calc(100vw - 8px);box-sizing:border-box;padding:4px 8px;background:#17232e;color:white;font:11px/1.4 sans-serif;pointer-events:none;border-radius:4px";
    document.body.append(caption);
  });
  try {
    await page.screenshot({
      path: filename,
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await page
      .evaluate(() =>
        document.getElementById("diagnostics-fixture-caption")?.remove(),
      )
      .catch(() => {});
  }
}

async function noOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    diagnostic: Array.from(
      document.querySelectorAll('[role="region"][aria-label="查询诊断"]'),
    ).map((el) => ({ client: el.clientWidth, scroll: el.scrollWidth })),
  }));
  assert.ok(
    dimensions.root <= dimensions.viewport &&
      dimensions.body <= dimensions.viewport,
    "horizontal page overflow: " + JSON.stringify(dimensions),
  );
  assert.ok(
    dimensions.diagnostic.every((r) => r.scroll <= r.client + 1),
    "diagnostic report must not have internal horizontal overflow",
  );
}

async function expandedDiagnostic(
  page: Page,
  d: Diagnostic,
  defaultOpen = true,
): Promise<Locator> {
  const region = page.getByRole("region", { name: "查询诊断", exact: true });
  await region.waitFor({ state: "visible" });
  assert.equal(
    await region.count(),
    1,
    "exactly one diagnostic region per detail",
  );
  const details = (await region.evaluate(
    (el) => el instanceof HTMLDetailsElement,
  ))
    ? region
    : region.locator("details");
  const summary = region.locator("summary");
  await summary.waitFor();
  assert.equal(
    await details.count(),
    1,
    "diagnostic must have a native details/summary disclosure",
  );
  assert.equal(await summary.count(), 1);
  assert.match(await summary.innerText(), /查询诊断/);
  await until(
    async () => !(await region.innerText()).includes("正在测量"),
    "completed diagnostic is still showing its in-flight state",
  );
  if (defaultOpen)
    await until(
      () =>
        details.evaluate(
          (el, failure) => (el as HTMLDetailsElement).open === failure,
          d.outcome === "failure",
        ),
      "failure expands by default; successful queries are manually expandable",
    );
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await summary.click();
  await region
    .getByText(d.code === "response_html" ? "站点返回网页" : categoryTitles[d.category], { exact: false })
    .waitFor();
  const hint =
    d.code === "ok"
      ? d.operation === "test"
        ? "已读取并解析余额，测试没有修改余额或新增快照。"
        : "本次余额已写入真实历史快照。"
      : hints[d.code];
  assert.ok(hint, "browser case requires a fixed next-step oracle");
  await region.getByText(hint, { exact: false }).waitFor();
  if (d.httpStatus !== null)
    assert.match(
      await region.innerText(),
      new RegExp(`HTTP[^\\d]{0,20}${d.httpStatus}\\b`),
      "display actual upstream HTTP status, not API wrapper 502",
    );
  for (let i = 0; i < stageIds.length; i++) {
    const label = region.getByText(stageNames[i], { exact: true });
    await label.waitFor();
    const text = await label.evaluate((el, labels) => {
      const row = el.closest("li, tr, [role=row]");
      if (row) return row.textContent || "";
      const dt = el.closest("dt");
      if (dt)
        return (
          (dt.textContent || "") +
          " " +
          (dt.nextElementSibling?.textContent || "")
        );
      let parent = el.parentElement,
        last = el.textContent || "";
      while (parent) {
        const text = parent.textContent || "";
        if (labels.filter((s) => text.includes(s)).length !== 1) break;
        last = text;
        parent = parent.parentElement;
      }
      return last;
    }, stageNames);
    assert.ok(
      !/null|undefined|NaN/.test(text),
      "no missing-value strings in a stage row",
    );
    const stage = d.stages[i];
    if (stage.status === "not-run" || stage.status === "skipped") {
      assert.match(
        text,
        stage.status === "not-run"
          ? /未执行|未运行|未开始|尚未/
          : /跳过|无需|不需要/,
      );
      assert.ok(
        !/\d+(?:\.\d+)?\s*(?:ms\b|毫秒)/i.test(text),
        "skipped/unexecuted stages must not display invented numeric timings: " +
          stage.id,
      );
    } else
      assert.match(
        text,
        /\d+(?:\.\d+)?\s*(?:ms|毫秒)/i,
        "completed/error stage displays its measured duration: " + stage.id,
      );
  }
  await region
    .getByRole("button", { name: "复制脱敏报告", exact: true })
    .waitFor();
  return region;
}

async function unusedPort(preferred: number): Promise<number> {
  assert.ok(
    Number.isInteger(preferred) &&
      preferred >= 1024 &&
      preferred <= 65535 &&
      preferred !== 3000,
    "Refusing an invalid port or the real :3000 service",
  );
  const probe = async (port: number) => {
    const socket = createPortProbe();
    const result = await new Promise<number>((ok, fail) => {
      socket.once("error", fail);
      socket.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
        ok((socket.address() as { port: number }).port),
      );
    });
    await new Promise<void>((ok, fail) =>
      socket.close((e) => (e ? fail(e) : ok())),
    );
    return result;
  };
  try {
    return await probe(preferred);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    console.log(
      `Port ${preferred} occupied; choosing an unused dynamic port (no existing process will be stopped).`,
    );
    return probe(0);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  assert.ok(
    [...args].every((a) => ["--red-only", "--skip-timeouts"].includes(a)),
    "Supported flags: --red-only, --skip-timeouts",
  );
  const redOnly = args.has("--red-only"),
    skipTimeouts = args.has("--skip-timeouts");
  const cwd = process.cwd();
  const buildId = readFileSync(join(cwd, ".next/BUILD_ID"), "utf8").trim();
  const port = await unusedPort(
    Number(process.env.ATLAS_DIAGNOSTIC_PORT || 3320),
  );
  assert.notEqual(
    port,
    3000,
    "dynamic fallback must never select the real service's port",
  );
  const origin = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(join(tmpdir(), "atlas-diagnostics-ui-"));
  const runtime = join(temp, "runtime");
  const out = join(
    cwd,
    "output/playwright/diagnostics",
    new Date().toISOString().replace(/[:.]/g, "-") + `-${process.pid}`,
  );
  mkdirSync(out, { recursive: true });
  let hits = 0;
  const byMode: Partial<Record<Mode, number>> = {},
    fixtureErrors: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const held = new Set<ServerResponse>();
  const payload = () =>
    JSON.stringify({
      success: true,
      data: { quota: fixtureQuota },
      token: secret,
      userId,
      accountname: accountName,
      body: secret,
      domain: "fixture-private-domain.invalid",
      ip: "127.0.0.1",
    });
  const releaseHeld = () => {
    for (const res of held) if (!res.destroyed) res.end(payload());
    held.clear();
  };
  const fixture = createServer((req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-fixture-private-header", secret);
    const mode = req.url?.match(
      /^\/fixture-private-prefix\/(success|auth|missing|invalid-json|html|no-quota|pending|response-stall|read-stall)\/api\/user\/self$/,
    )?.[1] as Mode | undefined;
    if (
      !mode ||
      req.method !== "GET" ||
      req.headers.authorization !== `Bearer ${secret}` ||
      req.headers["new-api-user"] !== userId
    ) {
      fixtureErrors.push(
        "Unexpected provider path/method/auth/user-id; prefix must be preserved",
      );
      res.writeHead(500);
      res.end("fixture contract mismatch");
      return;
    }
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    if (mode === "auth" || mode === "missing") {
      res.writeHead(mode === "auth" ? 401 : 404);
      res.end(secret);
    } else if (mode === "invalid-json" || mode === "html") res.end(diagnosticFailureBody(mode, secret));
    else if (mode === "no-quota")
      res.end(
        JSON.stringify({
          success: true,
          data: { token: secret, body: secret, userId },
        }),
      );
    else if (mode === "pending") {
      held.add(res);
      res.once("close", () => held.delete(res));
    } else if (mode === "response-stall" || mode === "read-stall") {
      if (mode === "read-stall") {
        res.writeHead(200);
        res.flushHeaders();
        res.write('{"success":true,"data":{"quota":');
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!res.destroyed)
          res.end(
            mode === "read-stall"
              ? JSON.stringify(fixtureQuota) + "}}"
              : payload(),
          );
      }, 12000);
      timers.add(timer);
      res.once("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    } else res.end(payload());
  });
  let server: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  let logs = "",
    checkpoint = "isolated setup",
    currentCheck = "setup",
    failure: unknown,
    missingUi = false;
  let databaseRemoved = false,
    childStopped = false,
    browserClosed = false,
    fixtureClosed = false;
  const checks: Check[] = [],
    errors: string[] = [],
    cleanupErrors: string[] = [];
  const expectedHttp502: string[] = [],
    expectedFailureUrls = new Set<string>();
  const screenshots: string[] = [];
  const visualCases = ["light", "dark"].flatMap((theme) =>
    [375, 768, 1440].flatMap((width) =>
      ["no-preference", "reduce"].map((motion) => ({ theme, width, motion })),
    ),
  );
  const requiredChecks = [
    "setup",
    "browser-sync-diagnostics",
    "sync-persistence-disclosure-copy-idle",
    "clipboard-failure-manual-copy",
    "failed-sync-auth",
    "failed-test-auth-preserves-sync",
    "failed-sync-missing",
    "failed-sync-invalid-json",
    "failed-sync-html",
    "failed-sync-no-quota",
    "successful-test-no-side-effects",
    "in-flight-no-fake-timing",
    "ip-literal-skipped-dns",
    "api-response-timeout",
    "api-read-timeout",
    "visual-fixture-setup",
    ...visualCases.map((c) => `visual-${c.theme}-${c.width}-${c.motion}`),
    "final-navigation-wait-zero-provider-requests",
  ];
  const check = async (name: string, work: () => Promise<void>) => {
    currentCheck = name;
    checkpoint = name;
    const before = hits;
    try {
      await work();
      checks.push({ name, status: "PASS", providerRequests: hits - before });
    } catch (e) {
      checks.push({ name, status: "FAIL", providerRequests: hits - before });
      throw e;
    }
  };
  const noQueries = async (label: string, work: () => Promise<void>) => {
    const before = hits;
    await work();
    await pause(200); // Bounded observation window for the negative/no-request contract.
    assert.equal(
      hits,
      before,
      label + " must not query/retry/poll the provider",
    );
  };
  try {
    await new Promise<void>((ok, fail) => {
      fixture.once("error", fail);
      fixture.listen(0, "127.0.0.1", ok);
    });
    const fixtureRoot = `http://localhost:${(fixture.address() as { port: number }).port}`;
    const fixtureIpRoot = fixtureRoot.replace("localhost", "127.0.0.1");
    copyIsolatedBuild(cwd, runtime);
    server = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
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
          ...cleanRuntimeEnv(),
          NEXT_TELEMETRY_DISABLED: "1",
          RELAYDOCK_DATA_DIR: temp,
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
      logs += String(b);
    });
    server.stderr!.on("data", (b) => {
      logs += String(b);
    });
    browser = await chromium.launch({
      headless: true,
      env: cleanRuntimeEnv() as Record<string, string>,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    // Only the external network boundary is guarded; no application/provider API is mocked.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!["http:", "https:"].includes(url.protocol) || url.origin === origin)
        await route.continue();
      else {
        errors.push("Unexpected external browser request: " + url.origin);
        await route.abort("blockedbyclient");
      }
    });
    page = await context.newPage();
    page.setDefaultTimeout(6000);
    const view = page;
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const url = message.location().url;
      if (
        expectedFailureUrls.has(url) &&
        /^Failed to load resource: the server responded with a status of 502\b/.test(
          message.text(),
        )
      )
        expectedHttp502.push(url);
      else errors.push("console.error: " + message.text());
    });
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText || "unknown";
      if (!reason.includes("ERR_ABORTED"))
        errors.push("requestfailed: " + request.url() + " " + reason);
    });
    let csrf = "",
      id = "",
      details: Record<string, unknown> = {};
    const api = async (
      path: string,
      method = "GET",
      data?: unknown,
      expectedStatus = 200,
    ) => {
      const r = await context.request.fetch(origin + "/api/" + path, {
        method,
        headers: { Origin: origin, "x-csrf-token": csrf },
        ...(data === undefined ? {} : { data }),
        timeout: 20000,
      });
      assert.equal(
        r.status(),
        expectedStatus,
        method + " " + path + " response status",
      );
      return object(await r.json(), "API response");
    };
    const state = async (): Promise<State> => {
      const data = await api("accounts");
      assert.ok(Array.isArray(data.accounts));
      const account = data.accounts.find((a: FixtureAccount) => a.id === id) as
        FixtureAccount | undefined;
      assert.ok(account, "fixture account must remain in isolated DB");
      const history = await api(`accounts/${id}/history`);
      assert.ok(Array.isArray(history.snapshots));
      return { account, snapshots: history.snapshots };
    };
    const openAccount = async () => {
      await view.reload();
      if (view.viewportSize()!.width <= 760)
        await view.locator(".site-identity").first().click();
      else await view.locator("[data-node]").first().click();
      await view.locator(".account-detail").waitFor();
    };
    const configure = async (mode: Mode, ip = false, reload = true) => {
      await noQueries("configuration/navigation", async () => {
        details = {
          ...details,
          managementUrl:
            (ip ? fixtureIpRoot : fixtureRoot) + prefix + "/" + mode,
        };
        await api(`accounts/${id}`, "PATCH", details);
        if (reload) await openAccount();
      });
    };
    const copy = async (d: Diagnostic) => {
      await noQueries("copy report", async () => {
        const sentinel = "fixture-clipboard-not-yet-written";
        await view.evaluate((s) => navigator.clipboard.writeText(s), sentinel);
        await view
          .getByRole("region", { name: "查询诊断", exact: true })
          .getByRole("button", { name: "复制脱敏报告", exact: true })
          .click();
        await view.waitForFunction(
          async (s) => (await navigator.clipboard.readText()) !== s,
          sentinel,
        );
        const text = await view.evaluate(() => navigator.clipboard.readText());
        const parsed = diagnostic(
          JSON.parse(text),
          d.operation,
          d.code,
          d.httpStatus,
          id,
        );
        assert.deepEqual(
          parsed,
          d,
          "copied JSON must equal the persisted whitelist, not account details/raw upstream response",
        );
      });
    };
    const persisted = async (d: Diagnostic) => {
      await noQueries("page refresh and opening diagnostic", async () => {
        await openAccount();
        assert.deepEqual(
          (await state()).account.lastQueryDiagnostic,
          d,
          "diagnostic survives a page refresh",
        );
        await expandedDiagnostic(view, d);
      });
      await copy(d);
    };
    let first = true;
    const browserQuery = async (
      action: Action,
      code: Code,
      httpStatus: number,
      during?: () => Promise<void>,
    ): Promise<Diagnostic> => {
      const before = await state(),
        beforeHits = hits;
      const url = origin + `/api/accounts/${id}/${action}`;
      if (code !== "ok") expectedFailureUrls.add(url);
      let waitError: unknown;
      const response = view
        .waitForResponse(
          (r) => r.url() === url && r.request().method() === "POST",
          { timeout: 20000 },
        )
        .catch((e) => {
          waitError = e;
          return undefined;
        });
      await view
        .locator(".account-detail")
        .getByRole("button", {
          name: action === "sync" ? "刷新余额" : "测试连接",
          exact: true,
        })
        .click();
      if (during) {
        try {
          await during();
        } finally {
          releaseHeld();
        }
      }
      const r = await response;
      if (!r) throw waitError || new Error("No browser query response");
      assert.equal(
        r.status(),
        code === "ok" ? 200 : 502,
        "query API status (distinct from provider HTTP status)",
      );
      const body = object(await r.json(), "browser query response");
      assert.equal(
        hits,
        beforeHits + 1,
        "exactly one provider request, no retry/fanout",
      );
      assert.deepEqual(fixtureErrors, []);
      if (first) {
        await view
          .getByRole("status")
          .filter({ hasText: "余额已同步" })
          .waitFor();
        checkpoint =
          "UI region[aria-label='查询诊断'] after successful browser sync";
        const region = view.getByRole("region", {
          name: "查询诊断",
          exact: true,
        });
        try {
          await region.waitFor({ state: "visible" });
        } catch (e) {
          missingUi = (await region.count()) === 0;
          throw e;
        }
        first = false;
      }
      const d = diagnostic(
        action === "sync" && code === "ok"
          ? body.lastQueryDiagnostic
          : body.diagnostic,
        action,
        code,
        httpStatus,
        id,
      );
      const after = await state();
      assert.deepEqual(
        after.account.lastQueryDiagnostic,
        d,
        "backend must persist the exact diagnostic whitelist",
      );
      if (action === "test" || code !== "ok") unchanged(before, after, action);
      else {
        assert.equal(after.account.balance, fixtureBalance);
        assert.equal(after.account.rawQuota, fixtureQuota);
        assert.equal(after.account.lastSyncStatus, "success");
        assert.equal(
          after.snapshots.length,
          before.snapshots.length + 1,
          "successful sync adds exactly one snapshot",
        );
        const added = after.snapshots.filter(
          (s) =>
            !before.snapshots.some(
              (old) => object(old, "snapshot").id === object(s, "snapshot").id,
            ),
        );
        assert.equal(added.length, 1);
        assert.equal(object(added[0], "sync snapshot").source, "sync");
        assert.equal(object(added[0], "sync snapshot").amount, fixtureBalance);
      }
      if (action === "test" && code === "ok")
        assert.equal(
          body.balance,
          fixtureBalance,
          "test can return fixture balance without persisting it",
        );
      await expandedDiagnostic(view, d);
      await copy(d);
      assert.deepEqual(
        errors,
        [],
        "no unexpected browser errors (known HTTP 502 resource messages are tracked separately)",
      );
      return d;
    };

    await check("setup", async () => {
      // A ready message must come from our child before any HTTP probe. Never use an existing listener.
      await until(
        async () => {
          if (spawnError) throw spawnError;
          assert.equal(
            server!.exitCode,
            null,
            "Owned next start exited: " + logs,
          );
          assert.equal(
            server!.signalCode,
            null,
            "Owned next start was interrupted",
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
        30000,
      );
      assert.ok(
        existsSync(join(temp, "atlas.sqlite")),
        "API must initialize SQLite only under the generated temp directory",
      );
      await view.goto(origin);
      await view.getByLabel("管理员密码", { exact: true }).fill(password);
      await view.getByRole("button", { name: "进入我的群岛" }).click();
      await view.getByRole("button", { name: "添加第一个站点" }).waitFor();
      const session = await api("auth/session");
      assert.equal(session.authenticated, true);
      assert.ok(typeof session.csrf === "string");
      csrf = session.csrf;
      const created = await api(
        "accounts",
        "POST",
        {
          name: accountName,
          siteUrl: fixtureRoot,
          managementUrl: fixtureRoot + prefix + "/success",
          provider: "newapi",
          credential: secret,
          userId,
          initialBalance,
          quotaPerUnit: "500000",
          query: { timeoutSeconds: 10 },
        },
        201,
      );
      assert.ok(typeof created.id === "string");
      id = created.id;
      const exported = await api("backup/export");
      assert.ok(Array.isArray(exported.accounts));
      details = object(
        exported.accounts.find((a) => object(a, "backup account").id === id)
          ?.details,
        "fixture account details",
      );
      const initial = await state();
      assert.equal(initial.account.balance, initialBalance);
      assert.equal(initial.account.lastSyncStatus, "never");
      assert.equal(initial.snapshots.length, 1);
      assert.equal(
        object(initial.snapshots[0], "initial snapshot").source,
        "manual",
      );
      assert.equal(initial.account.lastQueryDiagnostic ?? null, null);
      await openAccount();
      assert.equal(
        hits,
        0,
        "login/seeding/navigation must never query the provider",
      );
    });
    let synced: Diagnostic | undefined;
    await check("browser-sync-diagnostics", async () => {
      synced = await browserQuery("sync", "ok", 200);
    });
    if (!redOnly) {
      await check("sync-persistence-disclosure-copy-idle", async () => {
        assert.ok(synced);
        await persisted(synced);
        await noQueries("collapse/expand and idle", async () => {
          const region = view.getByRole("region", {
            name: "查询诊断",
            exact: true,
          });
          await region.locator("summary").click();
          await region.locator("summary").click();
          await pause(1100);
        });
        await copy(synced);
      });
      await check("clipboard-failure-manual-copy", async () => {
        assert.ok(synced);
        await noQueries("clipboard denied and manual fallback", async () => {
          // Avoid serializing tsx's keepNames helper into the browser scope.
          await view.evaluate(
            "Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new DOMException('fixture clipboard denied', 'NotAllowedError')) })",
          );
          try {
            const region = view.getByRole("region", {
              name: "查询诊断",
              exact: true,
            });
            await region
              .getByRole("button", { name: "复制脱敏报告", exact: true })
              .click();
            const textarea = region.getByRole("textbox", {
              name: "脱敏诊断报告",
              exact: true,
            });
            await textarea.waitFor();
            assert.ok(
              await textarea.evaluate(
                (el) => (el as HTMLTextAreaElement).readOnly,
              ),
            );
            assert.deepEqual(
              diagnostic(
                JSON.parse(await textarea.inputValue()),
                synced!.operation,
                synced!.code,
                synced!.httpStatus,
                id,
              ),
              synced,
            );
            await textarea.focus();
            assert.ok(
              await textarea.evaluate(
                (el) =>
                  (el as HTMLTextAreaElement).selectionEnd ===
                  (el as HTMLTextAreaElement).value.length,
              ),
            );
            await noOverflow(view);
          } finally {
            await view.evaluate(() => {
              delete (navigator.clipboard as unknown as Record<string, unknown>)
                .writeText;
            });
          }
        });
        await copy(synced);
      });
      await check("failed-sync-auth", async () => {
        await configure("auth");
        const d = await browserQuery("sync", "http_auth", 401);
        await persisted(d);
      });
      await check("failed-test-auth-preserves-sync", async () => {
        const d = await browserQuery("test", "http_auth", 401);
        await persisted(d);
      });
      for (const [mode, code, httpStatus] of [
        ["missing", "http_missing", 404],
        ...diagnosticFailureCases.map(({ mode, code, httpStatus }) => [mode, code, httpStatus] as const),
        ["no-quota", "invalid_balance", 200],
      ] as const) {
        await check("failed-sync-" + mode, async () => {
          await configure(mode);
          const d = await browserQuery("sync", code, httpStatus);
          await persisted(d);
        });
      }
      await check("successful-test-no-side-effects", async () => {
        await configure("success");
        const d = await browserQuery("test", "ok", 200);
        await persisted(d);
      });
      await check("in-flight-no-fake-timing", async () => {
        await configure("pending");
        let heldMs = 0;
        const d = await browserQuery("test", "ok", 200, async () => {
          await until(
            () => held.size === 1,
            "provider fixture did not receive the pending browser query",
          );
          const started = performance.now(),
            before = hits;
          const region = view.getByRole("region", {
            name: "查询诊断",
            exact: true,
          });
          await region.getByText("正在测量", { exact: false }).waitFor();
          assert.ok(
            !/\d+(?:\.\d+)?\s*(?:ms|毫秒)/i.test(await region.innerText()),
            "query-in-flight must not invent timer values or show stale stages as current measurements",
          );
          await pause(350);
          assert.equal(
            hits,
            before,
            "waiting for headers does not fan out/retry",
          );
          heldMs = performance.now() - started;
        });
        assert.ok(
          d.stages[2].durationMs !== null &&
            d.stages[2].durationMs >= heldMs - 100,
          "response stage measures the real held HTTP response, not a synthetic total",
        );
        await persisted(d);
      });
      await check("ip-literal-skipped-dns", async () => {
        await configure("success", true);
        const d = await browserQuery("test", "ok", 200);
        assert.equal(d.stages[0].status, "skipped");
        await persisted(d);
      });
      if (!skipTimeouts) {
        for (const [mode, code, stage, status] of [
          ["response-stall", "response_timeout", "response", null],
          ["read-stall", "read_timeout", "read", 200],
        ] as const) {
          await check(
            mode === "response-stall"
              ? "api-response-timeout"
              : "api-read-timeout",
            async () => {
              // Real HTTP API integration, not a browser wait or a mocked clock; 10s each.
              await configure(mode, false, false);
              const before = await state(),
                beforeHits = hits,
                started = performance.now();
              const body = await api(
                `accounts/${id}/sync`,
                "POST",
                undefined,
                502,
              );
              const elapsed = performance.now() - started;
              const d = diagnostic(body.diagnostic, "sync", code, status, id);
              assert.ok(
                elapsed >= 9900 && d.totalMs >= 9900,
                "10s timeout must be real, not an instantaneous fixture failure",
              );
              const failedStage = d.stages.find((s) => s.id === stage)!;
              assert.equal(failedStage.status, "error");
              assert.ok(
                failedStage.durationMs !== null &&
                  failedStage.durationMs >= 9500,
              );
              assert.ok(
                d.stages
                  .slice(stageIds.indexOf(stage) + 1)
                  .every(
                    (s) => s.status === "not-run" && s.durationMs === null,
                  ),
                "later stages are unexecuted, not fake zeros",
              );
              const after = await state();
              unchanged(before, after, "sync");
              assert.deepEqual(after.account.lastQueryDiagnostic, d);
              assert.equal(hits, beforeHits + 1);
            },
          );
        }
      }
      let visualDiagnostic: Diagnostic | undefined;
      await check("visual-fixture-setup", async () => {
        await configure("auth");
        visualDiagnostic = await browserQuery("test", "http_auth", 401);
      });
      for (const c of visualCases) {
        await check(`visual-${c.theme}-${c.width}-${c.motion}`, async () => {
          assert.ok(visualDiagnostic);
          await noQueries(
            "theme/viewport/media/navigation/disclosure/copy",
            async () => {
              await view.setViewportSize({
                width: c.width,
                height: c.width === 375 ? 812 : 960,
              });
              await view.emulateMedia({
                colorScheme: c.theme as "light" | "dark",
                reducedMotion: c.motion as "no-preference" | "reduce",
              });
              await api("settings", "PATCH", {
                theme: c.theme,
                motion: true,
                mapBackground: "grid",
              });
              await openAccount();
              assert.equal(
                await view.evaluate(
                  () => matchMedia("(prefers-reduced-motion: reduce)").matches,
                ),
                c.motion === "reduce",
              );
              const region = await expandedDiagnostic(view, visualDiagnostic!);
              await region.scrollIntoViewIfNeeded();
              await noOverflow(view);
              const file = `fixture-diagnostic-${c.theme}-${c.width}-${c.motion}.png`;
              await screenshot(view, join(out, file));
              screenshots.push(file);
            },
          );
          await copy(visualDiagnostic);
          assert.deepEqual(
            (await state()).account.lastQueryDiagnostic,
            visualDiagnostic,
          );
          assert.deepEqual(errors, []);
        });
      }
      await check("final-navigation-wait-zero-provider-requests", async () => {
        await noQueries("navigation and waiting", async () => {
          await openAccount();
          await pause(1100);
        });
        assert.deepEqual(fixtureErrors, []);
        assert.deepEqual(errors, []);
        assert.equal(
          readFileSync(join(cwd, ".next/BUILD_ID"), "utf8").trim(),
          buildId,
          "build changed mid-run; rerun against a stable updated build",
        );
      });
    }
    await context.tracing.stop({ path: join(out, "trace.zip") });
  } catch (e) {
    failure = e;
    if (page) {
      await screenshot(page, join(out, "failure-fixture.png")).catch(() => {});
      writeFileSync(
        join(out, "failure-dom.txt"),
        await page.content().catch(() => ""),
      );
      writeFileSync(
        join(out, "failure-aria.txt"),
        await page
          .locator("body")
          .ariaSnapshot()
          .catch(() => ""),
      );
      await page
        .context()
        .tracing.stop({ path: join(out, "trace.zip") })
        .catch(() => {});
    }
  } finally {
    const clean = async (label: string, work: () => Promise<void> | void) => {
      try {
        await work();
      } catch (e) {
        cleanupErrors.push(
          label + ": " + (e instanceof Error ? e.message : String(e)),
        );
      }
    };
    await clean("browser", async () => {
      await browser?.close();
      browserClosed = true;
    });
    await clean("owned next start", async () => {
      await stopOwnedServer(server);
      childStopped = true;
    });
    releaseHeld();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await clean("HTTP fixture", async () => {
      fixture.closeAllConnections();
      if (fixture.listening)
        await withDeadline(
          new Promise<void>((ok, fail) =>
            fixture.close((e) => (e ? fail(e) : ok())),
          ),
          5000,
          "fixture close timed out",
        );
      fixtureClosed = true;
    });
    writeFileSync(join(out, "server-log.txt"), logs);
    await clean("temp SQLite", () => {
      assert.ok(
        childStopped,
        "Owned server is still running; keep its temp database rather than deleting files underneath it",
      );
      // Validate absolute paths before native recursive removal; never compose cross-shell deletion.
      assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
      assert.ok(basename(temp).startsWith("atlas-diagnostics-ui-"));
      assert.notEqual(resolve(temp), resolve(cwd, "data"));
      assert.equal(resolve(runtime), join(resolve(temp), "runtime"));
      if (existsSync(join(runtime, "node_modules")))
        unlinkSync(join(runtime, "node_modules"));
      rmSync(temp, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      databaseRemoved = !existsSync(temp);
      assert.ok(databaseRemoved);
    });
    const notRun = requiredChecks.filter(
      (name) => !checks.some((c) => c.name === name),
    );
    const status = failure
      ? missingUi
        ? "RED"
        : "FAIL"
      : cleanupErrors.length
        ? "ERROR"
        : redOnly
          ? "SMOKE_PASS"
          : skipTimeouts
            ? "PASS_WITH_GAPS"
            : "PASS";
    const report = {
      status,
      checkpoint,
      currentCheck,
      checks,
      notRun,
      errors,
      fixtureErrors,
      cleanupErrors,
      expectedHttp502,
      fixtureRequests: hits,
      requestsByMode: byMode,
      screenshots,
      buildId,
      port,
      childPid: server?.pid,
      existingBuildOnly: true,
      isolatedDatabase: true,
      temporaryDatabaseRemoved: databaseRemoved,
      childStopped,
      browserClosed,
      fixtureClosed,
      fixtureAmountsOnly: true,
      realProviderVerified: false,
      timeoutCoverage: redOnly
        ? "not reached"
        : skipTimeouts
          ? "omitted explicitly; run without --skip-timeouts"
          : "two real 10s HTTP API cases (not browser waits)",
      failure:
        failure instanceof Error
          ? failure.message
          : failure
            ? String(failure)
            : null,
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
          checks,
          notRun,
          errors,
          fixtureRequests: hits,
          buildId,
          port,
          cleanupErrors,
          artifacts: out,
        },
        null,
        2,
      ),
    );
  }
  if (failure) throw failure;
  assert.deepEqual(cleanupErrors, [], "all owned resources must be cleaned");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
