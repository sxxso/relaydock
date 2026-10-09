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

// All data is synthetic. Fresh source build; no deployment env/data/.next reuse.
// External requests are allowed only to our local HTTP fixtures, and GET only.
const password = "fixture-model-insight-password";
const credential = "fixture-model-insight-management-key";
const rawLogSecret = "fixture-private-log-body-must-not-be-saved";
const root = resolve(process.cwd());
const redact = (value: unknown) => String(value).split(password).join("[redacted]").split(credential).join("[redacted]").split(rawLogSecret).join("[redacted]");
const pause = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
async function until(work: () => Promise<boolean>, label: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await work()) return; await pause(100); }
  throw new Error(label);
}
async function listen(server: Server) {
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  return (server.address() as { port: number }).port;
}
function buildStamp() {
  return [".next", ".next/BUILD_ID"].map((part) => {
    const path = join(root, part);
    return existsSync(path) ? { part, modified: statSync(path).mtimeMs, id: part.endsWith("BUILD_ID") ? readFileSync(path, "utf8") : "" } : { part, absent: true };
  });
}
async function main() {
  if (!process.argv.includes("--ready")) { console.log("WAITING_READY: pass --ready to build and verify isolated synthetic fixtures."); return; }
  const out = join(root, "output/playwright/model-insight", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  const beforeStamp = buildStamp();
  const checks: { name: string; status: string; ms: number; error?: string }[] = [];
  const errors: string[] = [], cleanupErrors: string[] = [], screenshots: string[] = [];
  const requests: { variant: string; path: string; authenticated: boolean; hours: string | null }[] = [];
  const buildLog = boundedLog(), serverLog = boundedLog();
  let owned: IsolatedSource | undefined, browser: Browser | undefined, page: Page | undefined;
  let child: ReturnType<typeof spawn> | undefined, build: Awaited<ReturnType<typeof buildIsolatedSource>> | undefined;
  let failure: unknown, modernDenied = false, modernCatalogOnly = false, delay = 0;
  const abort = new AbortController();
  const interrupt = () => { abort.abort(new Error("Acceptance interrupted")); void browser?.close().catch(() => {}); void stopOwnedChild(child).catch(() => {}); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 420_000);
  const now = Math.floor(Date.now() / 1000);
  const point = (ts: number, rate: number) => ({ ts, success_rate: rate, avg_latency_ms: 2300, avg_tps: 46.5, avg_ttft_ms: 320 });
  const provider = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://fixture.invalid");
    const match = url.pathname.match(/^\/(modern|legacy|denied|sample)(\/api\/.*)$/);
    if (req.method !== "GET" || !match) {
      errors.push("Fixture received a forbidden method/path"); res.writeHead(400).end(); return;
    }
    const [, variant, path] = match;
    const allowed = ["/api/status", "/api/pricing", "/api/perf-metrics/summary", "/api/perf-metrics", "/api/log/self"];
    if (!allowed.includes(path)) { errors.push("Fixture received an unlisted endpoint"); res.writeHead(400).end(); return; }
    const authenticated = req.headers.authorization === "Bearer " + credential;
    requests.push({ variant, path, authenticated, hours: url.searchParams.get("hours") });
    if (req.headers.authorization && !authenticated) errors.push("Unexpected fixture credential");
    const send = (body: unknown, status = 200) => {
      const answer = () => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } };
      if (delay) setTimeout(answer, delay); else answer();
    };
    if (path === "/api/status") {
      if (req.headers.authorization || req.headers["new-api-user"]) errors.push("Public status did not omit credentials");
      send({ success: true, data: { version: "fixture-only", system_name: "Synthetic New API", quota_per_unit: 123456 } });
    } else if (path === "/api/pricing") {
      send({ success: true, data: [
        { model_name: "claude-test", owner_by: "Synthetic", enable_groups: ["default"] },
        { model_name: "gpt-test", owner_by: "Synthetic", enable_groups: ["default"] },
        { model_name: "quiet-model", owner_by: "Synthetic", enable_groups: ["default"] },
      ] });
    } else if (path.startsWith("/api/perf-metrics")) {
      if (variant === "legacy" || variant === "sample" || (variant === "modern" && modernCatalogOnly)) send({ success: false }, 404);
      else if (variant === "denied" || modernDenied) send({ success: false, message: rawLogSecret }, 403);
      else if (path.endsWith("summary")) send({ success: true, data: { window_start: now - Number(url.searchParams.get("hours") || 24) * 3600, window_end: now, models: [
        { model_name: "claude-test", success_rate: 98.2, avg_latency_ms: 2300, avg_tps: 46.5, recent_success_series: [point(now - 7200, 96), point(now - 3600, 98.2)] },
        { model_name: "gpt-test", success_rate: 90, avg_latency_ms: 4100, avg_tps: 20, recent_success_rates: [80, 90] },
      ] } });
      else send({ success: true, data: { model_name: url.searchParams.get("model"), window_start: now - 86400, window_end: now, groups: [{ group: "default", success_rate: 98.2, avg_latency_ms: 2300, avg_tps: 46.5, avg_ttft_ms: 320, series: [point(now - 7200, 96), point(now - 3600, 98.2)] }] } });
    } else {
      if (variant === "modern" && modernCatalogOnly) { send({ success: false }, 403); return; }
      if (!authenticated) { send({ success: false }, 401); return; }
      const p = Number(url.searchParams.get("p") || 1);
      const entry = { type: 2, model_name: "claude-test", use_time: 2, prompt_tokens: 20, completion_tokens: 80, created_at: now - 60, other: JSON.stringify({ frt: 150 }), content: rawLogSecret, ip: "192.0.2.3", token_name: rawLogSecret };
      send({ success: true, data: { page: p, page_size: 100, total: variant === "sample" ? 800 : 3, items: variant === "sample" ? Array.from({ length: 100 }, (_, i) => ({ ...entry, id: (p - 1) * 100 + i + 1 })) : [entry, { ...entry, type: 5, completion_tokens: 0 }, { ...entry, type: 1 }] } });
    }
  });
  async function check(name: string, work: () => Promise<void>) {
    console.log(JSON.stringify({ check: name, status: "RUNNING" })); const start = Date.now();
    try { await work(); checks.push({ name, status: "PASS", ms: Date.now() - start }); }
    catch (e) { checks.push({ name, status: "FAIL", ms: Date.now() - start, error: redact(e) }); throw e; }
  }
  try {
    await check("fresh-isolated-production-build", async () => { owned = createIsolatedSource(root); build = await buildIsolatedSource(owned, cleanRuntimeEnv(), buildLog, abort.signal); });
    const runtime = owned!;
    const fixturePort = await listen(provider), probe = createServer(), port = await listen(probe);
    await new Promise<void>((ok) => probe.close(() => ok()));
    assert.notEqual(port, 3000);
    const origin = `http://127.0.0.1:${port}`, site = `http://127.0.0.1:${fixturePort}`, vault = randomBytes(32);
    const ids = {} as Record<string, string>;
    const store = new Store(join(runtime.dataDir, "atlas.sqlite"), vault);
    try {
      store.setMeta("adminHash", hashPassword(password)); store.setMeta("queryRoute", "direct"); store.setSettings({ theme: "light", motion: false });
      for (const variant of ["modern", "legacy", "denied", "sample"]) ids[variant] = store.create({ name: `模型夹具 ${variant}`, siteUrl: site, managementUrl: `${site}/${variant}`, provider: "newapi", credential, userId: "700123", initialBalance: "7.25", group: "模型测试" }).id;
    } finally { store.close(); }
    child = spawn(process.execPath, [join(runtime.depsTarget, "next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: runtime.runtime, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...cleanRuntimeEnv(), NEXT_TELEMETRY_DISABLED: "1", RELAYDOCK_DATA_DIR: runtime.dataDir, RELAYDOCK_VAULT_KEY: vault.toString("hex"), RELAYDOCK_PUBLIC_URL: origin, RELAYDOCK_DNS_MODE: "system", RELAYDOCK_PRIVATE_HOSTS: "127.0.0.1" },
    });
    child.stdout!.on("data", (b: Buffer) => serverLog.add(b)); child.stderr!.on("data", (b: Buffer) => serverLog.add(b));
    child.on("error", (e) => { errors.push("Owned server: " + redact(e)); abort.abort(e); });
    await until(async () => { try { return (await fetch(origin + "/api/auth/session", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "Fixture app did not start");
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce", serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) await route.continue();
      else { errors.push("Blocked non-fixture browser network"); await route.abort(); }
    });
    page = await context.newPage(); const view = page;
    view.setDefaultTimeout(8000); view.on("pageerror", (e) => errors.push(redact(e)));
    view.on("response", (res) => { if (res.status() >= 400 && !res.url().includes("/models")) errors.push("Unexpected browser HTTP " + res.status()); });
    await view.goto(origin); await view.getByLabel("管理员密码").fill(password); await view.getByRole("button", { name: "进入我的群岛" }).click();
    await view.getByRole("button", { name: "列表视图" }).click();
    const open = async (variant: string) => {
      if (await view.getByRole("dialog").count()) await view.getByRole("button", { name: "关闭对话框" }).click();
      if (await view.getByRole("button", { name: "关闭账号详情", exact: true }).count()) {
        await view.getByRole("button", { name: "关闭账号详情", exact: true }).click();
        await view.getByRole("complementary", { name: "当前账号详情" }).waitFor({ state: "detached" });
      }
      await view.getByText(`模型夹具 ${variant}`, { exact: true }).first().click();
      await view.getByRole("button", { name: "模型表现", exact: true }).click();
      await view.getByTestId("model-insight-panel").waitFor();
    };
    const panel = () => view.getByTestId("model-insight-panel");
    const update = async (variant: string, hours = 24) => {
      const wait = view.waitForResponse((r) => r.url().endsWith(`/accounts/${ids[variant]}/models`) && r.request().method() === "POST");
      const [, response] = await Promise.all([panel().getByTestId("model-refresh").click(), wait]);
      assert.equal(response.status(), 200); const data = await response.json(); assert.equal(data.hours, hours); return data;
    };
    await check("open-empty-cache-makes-no-external-request", async () => {
      const start = requests.length; await open("modern"); await panel().getByTestId("model-refresh").waitFor(); await pause(300); assert.equal(requests.length, start);
    });
    await check("site-metrics-catalog-unknowns-and-current-trends", async () => {
      const data = await update("modern"); assert.equal(data.source, "perf"); assert.equal(data.rows.length, 3); assert.ok(data.readAt);
      assert.equal(data.rows.find((r: any) => r.model === "quiet-model").successRate, null);
      assert.ok(data.rows.find((r: any) => r.model === "claude-test").trend[0].at);
      await panel().getByText("站点公开流量统计", { exact: false }).first().waitFor();
      assert.equal(await panel().getByTestId("model-row").count(), 3);
    });
    await check("local-search-traffic-filter-sort-no-network", async () => {
      const start = requests.length;
      await panel().getByLabel("搜索模型").fill("claude-test"); assert.equal(await panel().getByTestId("model-row").count(), 1);
      await panel().getByLabel("搜索模型").fill(""); await panel().getByLabel("仅显示有流量").check(); assert.equal(await panel().getByTestId("model-row").count(), 2);
      await panel().getByLabel("仅显示有流量").uncheck();
      await panel().getByRole("combobox", { name: "模型排序" }).click(); await view.getByRole("option", { name: "成功率优先" }).click();
      await view.getByRole("option", { name: "成功率优先" }).waitFor({ state: "hidden" });
      await until(async () => (await panel().getByRole("combobox", { name: "模型排序" }).innerText()).includes("成功率优先"), "Sort choice must finish applying before the next action");
      assert.equal(requests.length, start);
    });
    await check("explicit-model-detail-groups-and-trend", async () => {
      const pending = view.waitForResponse((r) => r.url().endsWith(`/accounts/${ids.modern}/models/detail`) && r.request().method() === "POST");
      const [, response] = await Promise.all([panel().getByRole("button", { name: "查看 claude-test 趋势" }).click(), pending]);
      const data = await response.json(); assert.equal(data.source, "perf"); assert.equal(data.groups[0].group, "default"); assert.ok(data.groups[0].series.length);
      await panel().getByTestId("model-detail").waitFor();
      await view.screenshot({ path: join(out, "model-detail.png") }); screenshots.push("model-detail.png");
    });
    await check("cache-reopen-does-not-read-provider", async () => {
      const start = requests.length; await open("modern"); await panel().getByTestId("model-row").first().waitFor(); assert.equal(requests.length, start);
    });
    await check("window-change-requires-explicit-update", async () => {
      for (const hours of [72, 168, 24]) {
        const start = requests.length;
        await panel().getByRole("combobox", { name: "统计窗口" }).click(); await view.getByRole("option", { name: `${hours} 小时`, exact: true }).click();
        assert.equal(requests.length, start); await update("modern", hours);
      }
    });
    await check("keyboard-filter-sort-and-explicit-trend", async () => {
      const start = requests.length;
      const traffic = panel().getByLabel("仅显示有流量");
      await traffic.focus(); await traffic.press("Space");
      assert.equal(await panel().getByTestId("model-row").count(), 2);
      await traffic.press("Space");
      const sort = panel().getByRole("combobox", { name: "模型排序" });
      await sort.focus(); await sort.press("Enter");
      await view.getByRole("option", { name: "模型名称", exact: true }).press("ArrowDown");
      await until(async () => view.getByRole("option", { name: "成功率优先", exact: true }).evaluate((el) => el === document.activeElement), "Keyboard navigation must focus the next sort option");
      await view.keyboard.press("Enter");
      await until(async () => (await sort.innerText()).includes("成功率优先"), "Keyboard selection must apply success-rate sorting");
      assert.equal(requests.length, start);
      const trend = panel().getByRole("button", { name: "查看 claude-test 趋势" });
      await trend.focus();
      const pending = view.waitForResponse((r) => r.url().endsWith(`/accounts/${ids.modern}/models/detail`) && r.request().method() === "POST");
      const [, response] = await Promise.all([trend.press("Enter"), pending]); assert.equal(response.status(), 200);
      const detail = panel().getByTestId("model-detail"); await detail.waitFor(); await detail.scrollIntoViewIfNeeded();
      assert.equal(await detail.getByRole("img", { name: "成功率趋势，纵轴从 0% 到 100%" }).count(), 1);
      await detail.screenshot({ path: join(out, "keyboard-trend.png") }); screenshots.push("keyboard-trend.png");
    });
    await check("404-personal-logs-fallback-and-estimated-speed", async () => {
      await open("legacy"); const data = await update("legacy"); assert.equal(data.source, "log"); const row = data.rows.find((r: any) => r.model === "claude-test"); assert.equal(row.sampleCount, 2); assert.equal(row.successRate, 50); assert.equal(row.avgTps, 40);
      await panel().getByText("我的调用记录", { exact: false }).first().waitFor();
      await view.screenshot({ path: join(out, "personal-logs.png") }); screenshots.push("personal-logs.png");
    });
    await check("600-record-cap-is-marked-truncated", async () => {
      await open("sample"); const start = requests.length; const data = await update("sample"); assert.equal(data.truncated, true); assert.equal(data.rows.find((r: any) => r.model === "claude-test").sampleCount, 600);
      assert.equal(requests.slice(start).filter((r) => r.path === "/api/log/self").length, 6);
    });
    await check("403-is-not-automatic-log-fallback", async () => {
      await open("denied"); const start = requests.length;
      const wait = view.waitForResponse((r) => r.url().endsWith(`/accounts/${ids.denied}/models`) && r.request().method() === "POST"); await Promise.all([panel().getByTestId("model-refresh").click(), wait]);
      assert.ok(!requests.slice(start).some((r) => r.path === "/api/log/self"));
      await panel().getByRole("combobox", { name: "数据来源" }).click(); await view.getByRole("option", { name: "我的调用记录", exact: true }).click();
      const data = await update("denied"); assert.equal(data.source, "log");
    });
    await check("failure-preserves-last-cache-and-visible-feedback", async () => {
      await open("modern"); await panel().getByTestId("model-row").first().waitFor(); modernDenied = true;
      const pending = view.waitForResponse((r) => r.url().endsWith(`/accounts/${ids.modern}/models`) && r.request().method() === "POST"); await Promise.all([panel().getByTestId("model-refresh").click(), pending]);
      assert.ok(await panel().getByTestId("model-row").count() >= 3); assert.ok(!(await panel().innerText()).includes(rawLogSecret));
      assert.ok((await panel().innerText()).includes("站点公开流量统计"));
      assert.ok(/98\.2/.test(await panel().getByTestId("model-row").filter({ hasText: "claude-test" }).innerText()), "Previous metric must remain visible after failure");
      assert.ok(/旧|未更新|上次|权限|拒绝/.test(await panel().innerText())); modernDenied = false;
      await view.screenshot({ path: join(out, "cached-error.png") }); screenshots.push("cached-error.png");
    });
    await check("catalog-only-response-preserves-existing-performance", async () => {
      modernCatalogOnly = true;
      const data = await update("modern"); assert.equal(data.source, "catalog");
      assert.ok(/98\.2/.test(await panel().getByTestId("model-row").filter({ hasText: "claude-test" }).innerText()));
      assert.ok((await panel().innerText()).includes("个人调用记录读取权限不足"));
      modernCatalogOnly = false;
    });
    await check("late-response-after-close-not-applied-to-another-account", async () => {
      delay = 250; const pending = view.waitForResponse((r) => r.url().endsWith(`/accounts/${ids.modern}/models`) && r.request().method() === "POST");
      void pending.catch(() => {}); // Navigation intentionally precedes awaiting the response; preserve cleanup on failure.
      await panel().getByTestId("model-refresh").click(); await view.getByRole("button", { name: "关闭对话框" }).click();
      await open("legacy"); await panel().getByTestId("model-row").first().waitFor(); await pending; delay = 0;
      assert.ok((await panel().innerText()).includes("我的调用记录"));
    });
    for (const width of [375, 768, 1440]) for (const theme of ["light", "dark"]) {
      await check(`viewport-${width}-${theme}`, async () => {
        await view.setViewportSize({ width, height: width === 375 ? 860 : 960 });
        if (await view.getByRole("dialog").count()) await view.getByRole("button", { name: "关闭对话框" }).click();
        const wanted = theme === "dark" ? "切换到深色" : "切换到浅色";
        if (await view.getByRole("button", { name: wanted, exact: true }).count()) await view.getByRole("button", { name: wanted, exact: true }).click();
        await open("modern"); await panel().getByTestId("model-row").first().waitFor();
        assert.equal(await view.evaluate(() => document.documentElement.dataset.theme), theme);
        assert.ok(await view.evaluate(() => document.body.scrollWidth <= innerWidth + 1), "Page must not overflow horizontally");
        const name = `${width}-${theme}-models.png`; await view.screenshot({ path: join(out, name) }); screenshots.push(name);
      });
    }
    await check("idle-and-query-state-do-not-change-balances-or-raw-logs", async () => {
      const start = requests.length; await pause(1200); assert.equal(requests.length, start);
      const db = new Database(join(runtime.dataDir, "atlas.sqlite"), { readonly: true });
      try {
        const rows = db.prepare("SELECT payload FROM accounts").all() as { payload: string }[];
        for (const row of rows) assert.equal(JSON.parse(row.payload).balance, "7.25");
        const cache = db.prepare("SELECT * FROM model_insights").all();
        assert.ok(cache.length >= 3); const serialized = JSON.stringify(cache);
        assert.ok(!serialized.includes(rawLogSecret) && !serialized.includes(credential));
        assert.equal((db.prepare("SELECT count(*) AS count FROM snapshots").get() as { count: number }).count, 4);
      } finally { db.close(); }
      assert.equal(errors.length, 0, errors.join("\n"));
    });
  } catch (e) {
    failure = e; if (page && !page.isClosed()) await page.screenshot({ path: join(out, "failure.png") }).then(() => screenshots.push("failure.png")).catch(() => {});
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    for (const [label, action] of [
      ["browser", () => browser?.close()], ["owned-server", () => stopOwnedChild(child)],
      ["provider", async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>((ok) => provider.close(() => ok())); }],
      ["owned-runtime", () => { if (owned) cleanupIsolatedSource(owned); }],
      ["repository-build-preserved", () => assert.deepEqual(buildStamp(), beforeStamp)],
    ] as const) { try { await action(); } catch (e) { cleanupErrors.push(label + ": " + redact(e)); } }
    writeFileSync(join(out, "build.log"), redact(buildLog.text())); writeFileSync(join(out, "server.log"), redact(serverLog.text()));
    const report = { status: failure || cleanupErrors.length ? "FAIL" : "PASS", at: new Date().toISOString(), build, sourceFingerprint: owned?.sourceFingerprint, checks, errors, cleanupErrors, requests, screenshots, failure: failure ? redact(failure) : null };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, passed: checks.filter((c) => c.status === "PASS").length, checks: checks.length, requests: requests.length, report: join(out, "report.json"), failure: report.failure, cleanupErrors }));
    if (report.status !== "PASS") process.exitCode = 1;
  }
}
void main().catch((e) => { console.error(redact(e)); process.exitCode = 1; });
