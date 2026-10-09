import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { chromium, type Browser, type Page } from "playwright";
import { Store } from "../src/lib/store";
import { hashPassword } from "../src/lib/crypto";
import { cleanRuntimeEnv } from "./isolated-runtime";
import { boundedLog, buildIsolatedSource, cleanupIsolatedSource, createIsolatedSource, stopOwnedChild, type IsolatedSource } from "./build-source-isolated";

// Synthetic fixtures only; no deployment env/data and no existing build reuse.
const root = resolve(process.cwd()), password = "fixture-checkin-password", credential = "fixture-checkin-management-key";
const privateEcho = "fixture-private-checkin-body-do-not-save";
const redact = (value: unknown) => String(value).split(password).join("[redacted]").split(credential).join("[redacted]").split(privateEcho).join("[redacted]");
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(work: () => Promise<boolean>, label: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await work()) return; await pause(100); }
  throw new Error(label);
}
async function listen(server: Server) {
  await new Promise<void>((r, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", r); });
  return (server.address() as { port: number }).port;
}
const buildStamp = () => [".next", ".next/BUILD_ID"].map(part => {
  const path = join(root, part);
  return existsSync(path) ? { part, mtime: statSync(path).mtimeMs, id: part.endsWith("BUILD_ID") ? readFileSync(path, "utf8") : "" } : { part, absent: true };
});
async function main() {
  if (!process.argv.includes("--ready")) { console.log("WAITING_READY: pass --ready for a fresh build and synthetic check-in acceptance."); return; }
  const out = join(root, "output/playwright/checkin", new Date().toISOString().replace(/[:.]/g, "-")); mkdirSync(out, { recursive: true });
  const beforeStamp = buildStamp(), buildLog = boundedLog(), serverLog = boundedLog();
  const checks: { name: string; status: string; ms: number; error?: string }[] = [], errors: string[] = [], cleanupErrors: string[] = [], screenshots: string[] = [];
  const requests: { variant: string; path: string; method: string; month: string | null }[] = [];
  let owned: IsolatedSource | undefined, browser: Browser | undefined, page: Page | undefined, child: ReturnType<typeof spawn> | undefined;
  let build: Awaited<ReturnType<typeof buildIsolatedSource>> | undefined, failure: unknown, delay = 0;
  const abort = new AbortController();
  const interrupt = () => { abort.abort(new Error("Acceptance interrupted")); void browser?.close().catch(() => {}); void stopOwnedChild(child).catch(() => {}); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt); const timer = setTimeout(interrupt, 420_000);
  const checked = new Set(["already"]), fixtureDate = "2026-10-08", currentMonth = "2026-10";
  const variants = ["success", "balancefail", "already", "disabled", "web", "unknown", "business", "bulk", "bulkduplicate", "late"];
  const provider = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://fixture.invalid"), match = url.pathname.match(/^\/(success|balancefail|already|disabled|web|unknown|business|bulk|late)(\/api\/user\/(checkin|self))$/);
    if (!match || !["GET", "POST"].includes(req.method || "") || (req.method === "POST" && !url.pathname.endsWith("checkin"))) {
      errors.push("Forbidden fixture request method/path"); res.writeHead(400).end(); return;
    }
    const [, variant, path] = match;
    requests.push({ variant, path, method: req.method!, month: url.searchParams.get("month") });
    if (req.headers.authorization !== "Bearer " + credential || req.headers["new-api-user"] !== "700123") { errors.push("Missing management credential/user identity"); res.writeHead(401).end(); return; }
    const send = (body: unknown, status = 200) => {
      const finish = () => { if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body)); };
      if (delay && variant === "late") setTimeout(finish, delay); else finish();
    };
    if (path.endsWith("self")) {
      if (variant === "balancefail") send({ success: false, message: privateEcho }, 500);
      else send({ success: true, data: { quota: 85000 } }); return;
    }
    if (variant === "web") { send({ success: false, message: privateEcho }, 403); return; }
    if (variant === "disabled") { send({ success: false, message: "签到功能未启用" }); return; }
    if (req.method === "POST") {
      let bytes = 0; req.on("data", (b: Buffer) => { bytes += b.length; });
      req.on("end", () => { if (bytes > 4096) errors.push("Check-in request body exceeded bound"); });
      if (variant === "unknown") { res.destroy(); return; }
      if (variant === "business") { send({ success: false, message: privateEcho }); return; }
      checked.add(variant); send({ success: true, message: privateEcho, data: { checkin_date: fixtureDate, quota_awarded: 12500 } }); return;
    }
    const month = url.searchParams.get("month") || currentMonth;
    const records = month === currentMonth ? [{ checkin_date: "2026-10-03", quota_awarded: 10000 }, ...(checked.has(variant) ? [{ checkin_date: fixtureDate, quota_awarded: 12500 }] : [])] : [{ checkin_date: month + "-05", quota_awarded: 7500 }];
    send({ success: true, data: { enabled: true, min_quota: 5000, max_quota: 15000, stats: { checked_in_today: checked.has(variant), checkin_count: records.length, total_checkins: 17, total_quota: 210000, records } } });
  });
  async function check(name: string, work: () => Promise<void>) {
    console.log(JSON.stringify({ check: name, status: "RUNNING" })); const started = Date.now();
    try { await work(); checks.push({ name, status: "PASS", ms: Date.now() - started }); }
    catch (e) { checks.push({ name, status: "FAIL", ms: Date.now() - started, error: redact(e) }); throw e; }
  }
  try {
    await check("fresh-isolated-production-build", async () => { owned = createIsolatedSource(root); build = await buildIsolatedSource(owned, cleanRuntimeEnv(), buildLog, abort.signal); });
    const runtime = owned!, site = `http://127.0.0.1:${await listen(provider)}`, probe = createServer(), port = await listen(probe); await new Promise<void>(r => probe.close(() => r())); assert.notEqual(port, 3000);
    const origin = `http://127.0.0.1:${port}`, vault = randomBytes(32), ids: Record<string, string> = {};
    const store = new Store(join(runtime.dataDir, "atlas.sqlite"), vault);
    try {
      store.setMeta("adminHash", hashPassword(password)); store.setMeta("queryRoute", "direct"); store.setSettings({ theme: "light", motion: false });
      for (const variant of variants) ids[variant] = store.create({ name: `签到夹具 ${variant}`, siteUrl: site, managementUrl: `${site}/${variant === "bulkduplicate" ? "bulk" : variant}`, provider: "newapi", credential, userId: "700123", initialBalance: "7.25", quotaPerUnit: "10000", unit: "USD", group: "签到测试" }).id;
      ids.manual = store.create({ name: "签到夹具 manual", siteUrl: site, provider: "manual", initialBalance: "1", group: "签到测试" }).id;
      ids.archived = store.create({ name: "签到夹具 archived", siteUrl: site, managementUrl: `${site}/bulk`, provider: "newapi", credential, userId: "700124", initialBalance: "2", archived: true, group: "签到测试" }).id;
    } finally { store.close(); }
    child = spawn(process.execPath, [join(runtime.depsTarget, "next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: runtime.runtime, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...cleanRuntimeEnv(), NEXT_TELEMETRY_DISABLED: "1", RELAYDOCK_DATA_DIR: runtime.dataDir, RELAYDOCK_VAULT_KEY: vault.toString("hex"), RELAYDOCK_PUBLIC_URL: origin, RELAYDOCK_DNS_MODE: "system", RELAYDOCK_PRIVATE_HOSTS: "127.0.0.1" } });
    child.stdout!.on("data", (b: Buffer) => serverLog.add(b)); child.stderr!.on("data", (b: Buffer) => serverLog.add(b)); child.on("error", e => { errors.push("Owned server: " + redact(e)); abort.abort(e); });
    await until(async () => { try { return (await fetch(origin + "/api/auth/session", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "Fixture app did not start");
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce", serviceWorkers: "block" });
    await context.route("**/*", async route => { const url = new URL(route.request().url()); if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) await route.continue(); else { errors.push("Blocked non-fixture browser request"); await route.abort(); } });
    page = await context.newPage(); const view = page; view.setDefaultTimeout(8000); view.on("pageerror", e => errors.push(redact(e)));
    await view.goto(origin); await view.getByLabel("管理员密码").fill(password); await view.getByRole("button", { name: "进入我的群岛" }).click(); await view.getByRole("button", { name: "列表视图" }).click();
    const close = async () => { if (await view.getByRole("dialog").count()) await view.getByRole("button", { name: "关闭对话框" }).click(); };
    const open = async (variant: string) => {
      await close();
      if (await view.getByRole("button", { name: "关闭账号详情", exact: true }).count()) { await view.getByRole("button", { name: "关闭账号详情", exact: true }).click(); await view.getByRole("complementary", { name: "当前账号详情" }).waitFor({ state: "detached" }); }
      await view.getByText(`签到夹具 ${variant}`, { exact: true }).first().click(); await view.getByRole("button", { name: "签到与月历", exact: true }).click(); await view.getByTestId("checkin-panel").waitFor();
    };
    const panel = () => view.getByTestId("checkin-panel");
    const postCount = (variant: string) => requests.filter(r => r.variant === variant && r.method === "POST").length;
    const query = async (variant: string) => { const pending = view.waitForResponse(r => r.url().includes(`/accounts/${ids[variant]}/checkin/status`) && r.request().method() === "POST"); await panel().getByRole("button", { name: "查询签到状态", exact: true }).click(); const response = await pending; assert.equal(response.status(), 200); return response.json(); };
    const signin = async (variant: string) => { const pending = view.waitForResponse(r => r.url().endsWith(`/accounts/${ids[variant]}/checkin`) && r.request().method() === "POST"); await panel().getByRole("button", { name: "立即签到", exact: true }).click(); const response = await pending; assert.equal(response.status(), 200); return response.json(); };
    await check("open-cache-only-no-provider-traffic", async () => { const start = requests.length; await open("success"); await pause(300); assert.equal(requests.length, start); });
    await check("explicit-query-renders-site-calendar-and-quota", async () => { await panel().getByLabel("签到月份", { exact: true }).fill(currentMonth); await query("success"); await panel().getByText("2026-10-03", { exact: false }).first().waitFor(); assert.equal(postCount("success"), 0); assert.ok((await panel().innerText()).includes("配额")); });
    await check("month-change-cache-only-explicit-query", async () => {
      const start = requests.length; await panel().getByLabel("签到月份", { exact: true }).fill("2026-09"); await pause(200); assert.equal(requests.length, start); await query("success"); assert.equal(requests.at(-1)?.month, "2026-09"); await panel().getByText("2026-09-05", { exact: false }).first().waitFor(); await panel().getByLabel("签到月份", { exact: true }).fill(currentMonth); await query("success");
    });
    await check("manual-signin-once-server-date-reward-and-balance-refresh", async () => {
      await panel().getByLabel("成功后刷新余额", { exact: true }).check(); await signin("success"); assert.equal(postCount("success"), 1); await until(async () => (await panel().innerText()).includes("签到成功"), "Success feedback missing"); assert.ok(requests.some(r => r.variant === "success" && r.path.endsWith("self"))); await view.screenshot({ path: join(out, "signin-success.png") }); screenshots.push("signin-success.png");
    });
    await check("calendar-shows-converted-reward-retains-raw-quota", async () => {
      const cell = panel().getByRole("cell", { name: /2026-10-08，已签到/ });
      assert.equal(await cell.locator(".checkin-day-quota").innerText(), "$1.25");
      assert.match(await cell.getAttribute("aria-label") || "", /12,500 配额/);
      assert.match(await cell.getAttribute("title") || "", /12,500 配额/);
      assert.equal(await panel().getByRole("cell", { name: /2026-10-03，已签到/ }).locator(".checkin-day-quota").innerText(), "$1");
    });
    await check("cached-reopen-idle-and-already-signed-no-post", async () => {
      const start = requests.length; await open("success");
      await until(async () => /缓存.*可能.*过期/.test(await panel().innerText()), "Cached signed status needs an expiry and refresh hint");
      assert.equal(await panel().getByRole("button", { name: "查询签到状态", exact: true }).isEnabled(), true);
      assert.equal(requests.length, start); await open("already"); await query("already"); assert.equal(postCount("already"), 0); assert.ok((await panel().innerText()).includes("已签到"));
    });
    await check("success-preserved-on-balance-failure", async () => { await open("balancefail"); await panel().getByLabel("成功后刷新余额", { exact: true }).check(); await signin("balancefail"); assert.equal(postCount("balancefail"), 1); await until(async () => /余额.*失败|余额.*未更新/.test(await panel().innerText()), "Separate balance failure feedback missing"); assert.ok((await panel().innerText()).includes("签到成功")); await view.screenshot({ path: join(out, "balance-failure.png") }); screenshots.push("balance-failure.png"); });
    await check("disabled-and-web-required-no-external-post", async () => { for (const variant of ["disabled", "web"]) { await open(variant); await query(variant); assert.equal(postCount(variant), 0); assert.ok(/未启用|关闭|网页|权限/.test(await panel().innerText())); } });
    await check("unknown-response-barrier-blocks-subsequent-post", async () => { await open("unknown"); await signin("unknown"); assert.equal(postCount("unknown"), 1); await until(async () => (await panel().innerText()).includes("结果待确认"), "Unknown result feedback missing"); await query("unknown"); assert.equal(postCount("unknown"), 1); await open("unknown"); await pause(200); assert.ok((await panel().innerText()).includes("结果待确认")); assert.equal(await panel().getByRole("button", { name: "立即签到", exact: true }).isDisabled(), true); await view.screenshot({ path: join(out, "uncertain.png") }); screenshots.push("uncertain.png"); });
    await check("business-failure-safe-feedback", async () => { await open("business"); await signin("business"); assert.equal(postCount("business"), 1); assert.ok(!(await panel().innerText()).includes(privateEcho)); });
    await check("close-and-account-change-ignore-late-response", async () => { await open("late"); delay = 600; const pending = view.waitForResponse(r => r.url().includes(`/accounts/${ids.late}/checkin/status`) && r.request().method() === "POST"); await panel().getByRole("button", { name: "查询签到状态", exact: true }).click(); await close(); await open("success"); await pending; delay = 0; await view.getByRole("heading", { name: "签到与月历 · 签到夹具 success", exact: true }).waitFor(); assert.ok((await panel().innerText()).includes("缓存显示已签到")); });
    await check("selected-batch-scope-remains-explicit", async () => {
      await close(); if (await view.getByRole("button", { name: "关闭账号详情", exact: true }).count()) await view.getByRole("button", { name: "关闭账号详情", exact: true }).click();
      await view.getByRole("button", { name: "批量管理", exact: true }).click();
      for (const variant of ["success", "already"]) await view.locator(`[data-site-row="${ids[variant]}"]`).getByRole("checkbox").check();
      const start = requests.length; await view.getByRole("button", { name: "批量签到", exact: true }).click(); await view.getByTestId("checkin-batch-panel").waitFor();
      await until(async () => (await view.getByTestId("checkin-batch-panel").innerText()).includes("缓存已签，执行时再次核对"), "Batch preview needs a local cached signed hint"); assert.equal(requests.length, start);
      const pending = view.waitForResponse(r => r.url().endsWith("/api/checkin/batch") && r.request().method() === "POST"); await view.getByRole("button", { name: "开始签到", exact: true }).click(); const data = await (await pending).json();
      assert.deepEqual(data.results.map((r: { accountId: string }) => r.accountId).sort(), [ids.success, ids.already].sort()); assert.ok(data.results.every((r: { outcome: string }) => r.outcome === "already_signed"));
      await until(async () => !await view.getByRole("button", { name: "关闭对话框" }).isDisabled(), "Batch dialog did not finish"); await close();
      for (const variant of ["success", "already"]) await view.locator(`[data-site-row="${ids[variant]}"]`).getByRole("checkbox").uncheck();
      await view.getByRole("button", { name: "退出批量管理", exact: true }).click();
    });
    await check("batch-preview-no-network-explicit-range-results-dedupe", async () => {
      await close(); if (await view.getByRole("button", { name: "关闭账号详情", exact: true }).count()) await view.getByRole("button", { name: "关闭账号详情", exact: true }).click();
      const start = requests.length; await view.getByRole("button", { name: "批量签到", exact: true }).click(); await view.getByTestId("checkin-batch-panel").waitFor();
      await until(async () => (await view.getByTestId("checkin-batch-panel").innerText()).includes("缓存已签，执行时再次核对"), "Filtered batch preview needs cached signed hints"); assert.equal(requests.length, start);
      const pending = view.waitForResponse(r => r.url().endsWith("/api/checkin/batch") && r.request().method() === "POST"); await view.getByRole("button", { name: "开始签到", exact: true }).click(); const response = await pending; assert.equal(response.status(), 200); const result = await response.json(); assert.ok(JSON.stringify(result).includes(ids.bulk)); assert.equal(postCount("bulk"), 1); assert.equal(postCount("unknown"), 1); assert.equal(postCount("already"), 0);
      await view.screenshot({ path: join(out, "batch-results.png") }); screenshots.push("batch-results.png");
    });
    for (const width of [375, 768, 1440]) for (const theme of ["light", "dark"]) await check(`viewport-${width}-${theme}`, async () => {
      await close(); await view.setViewportSize({ width, height: width === 375 ? 860 : 960 }); const wanted = theme === "dark" ? "切换到深色" : "切换到浅色"; if (await view.getByRole("button", { name: wanted, exact: true }).count()) await view.getByRole("button", { name: wanted, exact: true }).click();
      await open("success"); const calendar = panel().getByTestId("checkin-calendar"); await calendar.waitFor(); assert.ok(await view.evaluate(() => document.body.scrollWidth <= innerWidth + 1)); assert.equal(await view.evaluate(() => document.documentElement.dataset.theme), theme); const name = `${width}-${theme}-checkin.png`; await view.screenshot({ path: join(out, name) }); screenshots.push(name);
      await calendar.scrollIntoViewIfNeeded(); const calendarName = `${width}-${theme}-calendar.png`; await calendar.screenshot({ path: join(out, calendarName) }); screenshots.push(calendarName);
    });
    await check("keyboard-state-query-only-no-write", async () => { await open("already"); const posts = postCount("already"), pending = view.waitForResponse(r => r.url().includes(`/accounts/${ids.already}/checkin/status`) && r.request().method() === "POST"); const button = panel().getByRole("button", { name: "查询签到状态", exact: true }); await button.focus(); await button.press("Enter"); assert.equal((await pending).status(), 200); assert.equal(postCount("already"), posts); });
    await check("fixture-privacy-balances-and-idle-no-polling", async () => {
      const start = requests.length; await pause(1100); assert.equal(requests.length, start);
      const db = new Database(join(runtime.dataDir, "atlas.sqlite"), { readonly: true });
      try {
        const accounts = db.prepare("SELECT id,payload FROM accounts").all() as { id: string; payload: string }[];
        assert.equal(JSON.parse(accounts.find(a => a.id === ids.success)!.payload).balance, "8.5"); assert.equal(JSON.parse(accounts.find(a => a.id === ids.balancefail)!.payload).balance, "7.25");
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).filter(r => r.name.includes("checkin")); assert.ok(tables.length >= 2);
        for (const table of tables) { assert.match(table.name, /^[a-z_]+$/); const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table.name}`).all()); assert.ok(!rows.includes(credential) && !rows.includes(privateEcho)); }
      } finally { db.close(); }
      assert.equal(errors.length, 0, errors.join("\n"));
    });
  } catch (e) { failure = e; if (page && !page.isClosed()) await page.screenshot({ path: join(out, "failure.png") }).then(() => screenshots.push("failure.png")).catch(() => {}); }
  finally {
    clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    for (const [label, action] of [["browser", () => browser?.close()], ["owned-server", () => stopOwnedChild(child)], ["provider", async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>(r => provider.close(() => r())); }], ["owned-runtime", () => { if (owned) cleanupIsolatedSource(owned); }], ["repository-build-preserved", () => assert.deepEqual(buildStamp(), beforeStamp)]] as const) { try { await action(); } catch (e) { cleanupErrors.push(label + ": " + redact(e)); } }
    writeFileSync(join(out, "build.log"), redact(buildLog.text())); writeFileSync(join(out, "server.log"), redact(serverLog.text()));
    const report = { status: failure || cleanupErrors.length ? "FAIL" : "PASS", at: new Date().toISOString(), build, sourceFingerprint: owned?.sourceFingerprint, checks, errors, cleanupErrors, requests, screenshots, failure: failure ? redact(failure) : null };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, passed: checks.filter(c => c.status === "PASS").length, checks: checks.length, requests: requests.length, report: join(out, "report.json"), failure: report.failure, cleanupErrors })); if (report.status !== "PASS") process.exitCode = 1;
  }
}
void main().catch(e => { console.error(redact(e)); process.exitCode = 1; });
