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

// Fresh whitelisted source, generated SQLite and loopback provider only. No
// deployment data/.env/.next or real credentials; provider allows one endpoint.
const root = resolve(process.cwd()), password = "fixture-invitation-password", credential = "fixture-invitation-private-pat", privateEcho = "fixture-private-body";
const redact = (value: unknown) => String(value).split(password).join("[redacted]").split(credential).join("[redacted]").split(privateEcho).join("[redacted]");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(work: () => Promise<boolean>, label: string, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await work()) return; await pause(100); } throw new Error(label); }
async function listen(server: Server) { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return (server.address() as { port: number }).port; }
const buildStamp = () => [".next", ".next/BUILD_ID"].map(part => { const path = join(root, part); return existsSync(path) ? { part, mtime: statSync(path).mtimeMs, id: part.endsWith("BUILD_ID") ? readFileSync(path, "utf8") : "" } : { part, absent: true }; });
async function main() {
  if (!process.argv.includes("--ready")) { console.log("WAITING_READY: pass --ready for isolated invitation acceptance."); return; }
  const out = join(root, "output/playwright/invitation", new Date().toISOString().replace(/[:.]/g, "-")); mkdirSync(out, { recursive: true });
  const beforeStamp = buildStamp(), buildLog = boundedLog(), serverLog = boundedLog();
  const checks: { name: string; status: string; ms: number; error?: string }[] = [], errors: string[] = [], cleanupErrors: string[] = [], screenshots: string[] = [];
  const requests: { variant: string; path: string; method: string; authenticated: boolean }[] = [];
  let owned: IsolatedSource | undefined, browser: Browser | undefined, page: Page | undefined, child: ReturnType<typeof spawn> | undefined;
  let build: Awaited<ReturnType<typeof buildIsolatedSource>> | undefined, failure: unknown;
  const abort = new AbortController(), pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const interrupt = () => { abort.abort(new Error("Acceptance interrupted")); void browser?.close().catch(() => {}); void stopOwnedChild(child).catch(() => {}); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt); const timer = setTimeout(interrupt, 420000);
  const variants = ["success", "legacy", "denied", "html", "echo", "late", "missing", "archived"];
  const provider = createServer((req, res) => {
    const match = (req.url || "").match(/^\/(success|legacy|denied|html|echo|late)\/api\/user\/aff$/);
    if (req.method !== "GET" || !match) { errors.push("Provider received forbidden method/path"); res.writeHead(400).end(); return; }
    const variant = match[1], authenticated = req.headers.authorization === "Bearer " + credential && req.headers["new-api-user"] === "123";
    requests.push({ variant, path: req.url!, method: req.method, authenticated });
    if (!authenticated) { errors.push("Provider credential mismatch"); res.writeHead(401).end(); return; }
    if (variant === "legacy" || variant === "denied") { res.writeHead(variant === "legacy" ? 404 : 401).end(privateEcho); return; }
    if (variant === "html") { res.writeHead(200, { "Content-Type": "text/html" }).end("<html>" + privateEcho + "</html>"); return; }
    const answer = () => { if (!res.destroyed) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, data: variant === "echo" ? credential : variant === "late" ? "LATE" : "AFF12", privateEcho })); };
    if (variant === "late") { const pending = setTimeout(() => { pendingTimers.delete(pending); answer(); }, 700); pendingTimers.add(pending); } else answer();
  });
  async function check(name: string, work: () => Promise<void>) { console.log(JSON.stringify({ check: name, status: "RUNNING" })); const start = Date.now(); try { await work(); checks.push({ name, status: "PASS", ms: Date.now() - start }); } catch (e) { checks.push({ name, status: "FAIL", ms: Date.now() - start, error: redact(e) }); throw e; } }
  try {
    await check("fresh-isolated-production-build", async () => { owned = createIsolatedSource(root); build = await buildIsolatedSource(owned, cleanRuntimeEnv(), buildLog, abort.signal); });
    const runtime = owned!, fixture = `http://127.0.0.1:${await listen(provider)}`, probe = createServer(), port = await listen(probe); await new Promise<void>(resolve => probe.close(() => resolve())); assert.notEqual(port, 3000);
    const origin = `http://127.0.0.1:${port}`, vault = randomBytes(32), ids = {} as Record<string, string>;
    const store = new Store(join(runtime.dataDir, "atlas.sqlite"), vault);
    try { store.setMeta("adminHash", hashPassword(password)); store.setMeta("queryRoute", "direct"); store.setSettings({ theme: "light", motion: false }); for (const variant of variants) ids[variant] = store.create({ name: `邀请夹具 ${variant}`, siteUrl: "https://invite.example.test/keys", managementUrl: `${fixture}/${["missing", "archived"].includes(variant) ? "success" : variant}`, provider: "newapi", credential: variant === "missing" ? "" : credential, userId: "123", initialBalance: "7.25", group: "邀请测试", archived: variant === "archived" }).id; }
    finally { store.close(); }
    child = spawn(process.execPath, [join(runtime.depsTarget, "next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: runtime.runtime, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...cleanRuntimeEnv(), NEXT_TELEMETRY_DISABLED: "1", RELAYDOCK_DATA_DIR: runtime.dataDir, RELAYDOCK_VAULT_KEY: vault.toString("hex"), RELAYDOCK_PUBLIC_URL: origin, RELAYDOCK_DNS_MODE: "system", RELAYDOCK_PRIVATE_HOSTS: "127.0.0.1" } });
    child.stdout!.on("data", (b: Buffer) => serverLog.add(b)); child.stderr!.on("data", (b: Buffer) => serverLog.add(b)); child.on("error", e => { errors.push("Owned server: " + redact(e)); abort.abort(e); });
    await until(async () => { try { return (await fetch(origin + "/api/auth/session", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "Owned app did not start");
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce", serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
    await context.route("**/*", async route => { const url = new URL(route.request().url()); if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) await route.continue(); else { errors.push("Blocked non-fixture browser request"); await route.abort(); } });
    page = await context.newPage(); const view = page; view.setDefaultTimeout(8000); view.on("pageerror", error => errors.push(redact(error)));
    await view.goto(origin); await view.getByLabel("管理员密码").fill(password); await view.getByRole("button", { name: "进入我的群岛" }).click(); await view.getByRole("button", { name: "列表视图" }).click();
    const panel = () => view.getByTestId("invitation-panel");
    const close = async () => { if (await view.getByRole("dialog").count()) await view.getByRole("button", { name: "关闭对话框" }).click(); };
    const open = async (variant: string) => { await close(); if (await view.getByRole("button", { name: "关闭账号详情", exact: true }).count()) { await view.getByRole("button", { name: "关闭账号详情", exact: true }).click(); await view.getByRole("complementary", { name: "当前账号详情" }).waitFor({ state: "detached" }); } await view.getByRole("button", { name: "列表视图", exact: true }).click(); await view.getByText(`邀请夹具 ${variant}`, { exact: true }).first().click(); await view.getByRole("button", { name: "邀请链接", exact: true }).click(); await panel().waitFor(); await until(async () => !(await panel().innerText()).includes("正在读取本地邀请资料"), "Invitation local read did not settle"); };
    const fetchInvite = async (variant: string, status = 200, keyboard = false) => { const response = view.waitForResponse(r => r.url().endsWith(`/accounts/${ids[variant]}/invitation/fetch`) && r.request().method() === "POST"); const button = panel().getByRole("button", { name: "获取邀请码", exact: true }); if (keyboard) { await button.focus(); await button.press("Enter"); } else await button.click(); assert.equal((await response).status(), status); await until(async () => !(await panel().innerText()).includes("正在获取…"), "Invitation fetch did not settle"); };
    const save = async (manualUrl: string, registerUrl: string) => { await panel().getByLabel("手动邀请链接", { exact: true }).fill(manualUrl); await panel().getByLabel("自定义注册地址", { exact: true }).fill(registerUrl); const response = view.waitForResponse(r => r.url().endsWith(`/accounts/${ids.success}/invitation`) && r.request().method() === "PATCH"); await panel().getByRole("button", { name: "保存邀请资料", exact: true }).click(); assert.equal((await response).status(), 200); await panel().getByText("邀请资料已保存到本地。", { exact: true }).waitFor(); };
    await check("open-is-local-only-and-explains-generation", async () => { await open("success"); assert.equal(requests.length, 0); assert.ok((await panel().innerText()).includes("可能为你生成")); });
    await check("explicit-keyboard-fetch-one-fixed-authenticated-get", async () => { await fetchInvite("success", 200, true); await until(async () => await panel().getByLabel("已获取邀请码", { exact: true }).innerText() === "AFF12", "Code not rendered"); assert.equal(await panel().getByLabel("已保存邀请链接", { exact: true }).innerText(), "https://invite.example.test/sign-up?aff=AFF12"); assert.equal(requests.length, 1); assert.equal(requests[0].authenticated, true); });
    await check("copy-code-and-link", async () => { await panel().getByRole("button", { name: "复制邀请码", exact: true }).click(); assert.equal(await view.evaluate(() => navigator.clipboard.readText()), "AFF12"); await panel().getByRole("button", { name: "复制邀请链接", exact: true }).click(); assert.equal(await view.evaluate(() => navigator.clipboard.readText()), "https://invite.example.test/sign-up?aff=AFF12"); });
    await check("cache-reopen-and-reload-do-not-query-provider", async () => { const start = requests.length; await open("success"); assert.equal(await panel().getByLabel("已获取邀请码", { exact: true }).innerText(), "AFF12"); await close(); await view.reload(); await open("success"); assert.equal(await panel().getByLabel("已获取邀请码", { exact: true }).innerText(), "AFF12"); assert.equal(requests.length, start); });
    await check("manual-override-custom-base-passive-save-and-fetch-preservation", async () => { const start = requests.length; await save("https://share.example.test/?aff=MANUAL", "https://join.example.test/prefix/register?lang=zh"); assert.equal(requests.length, start); await fetchInvite("success"); assert.equal(await panel().getByLabel("已保存邀请链接", { exact: true }).innerText(), "https://share.example.test/?aff=MANUAL"); assert.ok((await panel().innerText()).includes("https://join.example.test/prefix/register?lang=zh&aff=AFF12")); });
    await check("clear-manual-restores-fetched-link-and-keeps-base", async () => { const start = requests.length; await save("", "https://join.example.test/prefix/register?lang=zh"); assert.equal(await panel().getByLabel("已保存邀请链接", { exact: true }).innerText(), "https://join.example.test/prefix/register?lang=zh&aff=AFF12"); assert.equal(requests.length, start); });
    for (const [variant, feedback] of [["legacy", "不支持标准邀请接口"], ["denied", "未授权"], ["html", "网页或验证页面"], ["echo", "未获取到有效邀请码"]]) await check(`safe-provider-${variant}`, async () => { await open(variant); await fetchInvite(variant, 502); assert.ok((await panel().getByRole("alert").innerText()).includes(feedback)); assert.ok(!(await panel().innerText()).includes(privateEcho)); assert.ok(!(await panel().innerText()).includes(credential)); });
    await check("missing-management-pat-blocks-local-fetch", async () => { const start = requests.length; await open("missing"); assert.equal(await panel().getByRole("button", { name: "获取邀请码", exact: true }).isDisabled(), true); assert.ok((await panel().innerText()).includes("管理 PAT")); assert.equal(requests.length, start); });
    await check("close-switch-account-ignore-late-provider-response", async () => { await open("late"); const response = view.waitForResponse(r => r.url().endsWith(`/accounts/${ids.late}/invitation/fetch`) && r.request().method() === "POST"); await panel().getByRole("button", { name: "获取邀请码", exact: true }).click(); await close(); await open("success"); assert.equal((await response).status(), 200); await pause(100); assert.ok(!(await panel().innerText()).includes("LATE")); assert.equal(await panel().getByLabel("已获取邀请码", { exact: true }).innerText(), "AFF12"); });
    for (const width of [375, 768, 1440]) for (const theme of ["light", "dark"]) await check(`viewport-${width}-${theme}`, async () => { await close(); await view.setViewportSize({ width, height: width === 375 ? 860 : 960 }); const toggle = theme === "dark" ? "切换到深色" : "切换到浅色"; if (await view.getByRole("button", { name: toggle, exact: true }).count()) await view.getByRole("button", { name: toggle, exact: true }).click(); await open("success"); assert.ok(await view.evaluate(() => document.body.scrollWidth <= innerWidth + 1)); assert.equal(await view.evaluate(() => document.documentElement.dataset.theme), theme); const file = `${width}-${theme}-invitation.png`; await view.screenshot({ path: join(out, file) }); screenshots.push(file); });
    await check("privacy-balances-backup-and-idle-no-polling", async () => {
      const start = requests.length; await pause(1100); assert.equal(requests.length, start); assert.deepEqual(errors, []);
      const db = new Database(join(runtime.dataDir, "atlas.sqlite"), { readonly: true });
      try { const values = JSON.stringify(db.prepare("SELECT * FROM invitations").all()); assert.ok(!values.includes(credential) && !values.includes(privateEcho)); const accounts = db.prepare("SELECT payload FROM accounts").all() as { payload: string }[]; assert.ok(accounts.every(account => JSON.parse(account.payload).balance === "7.25")); } finally { db.close(); }
      const stored = await view.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, page: document.body.textContent })); assert.ok(!stored.includes(credential) && !stored.includes(password) && !stored.includes(privateEcho));
      assert.equal(readFileSync(join(runtime.runtime, ".next/BUILD_ID"), "utf8").trim(), build!.buildId);
    });
  } catch (e) { failure = e; if (page && !page.isClosed()) await page.screenshot({ path: join(out, "failure.png") }).then(() => screenshots.push("failure.png")).catch(() => {}); }
  finally {
    clearTimeout(timer); for (const timer of pendingTimers) clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    for (const [label, action] of [["browser", () => browser?.close()], ["owned-server", () => stopOwnedChild(child)], ["provider", async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve())); }], ["owned-runtime", () => { if (owned) cleanupIsolatedSource(owned); }], ["repository-build-preserved", () => assert.deepEqual(buildStamp(), beforeStamp)]] as const) { try { await action(); } catch (error) { cleanupErrors.push(label + ": " + redact(error)); } }
    writeFileSync(join(out, "build.log"), redact(buildLog.text())); writeFileSync(join(out, "server.log"), redact(serverLog.text()));
    const report = { status: failure || cleanupErrors.length || errors.length ? "FAIL" : "PASS", at: new Date().toISOString(), build, sourceFingerprint: owned?.sourceFingerprint, checks, errors, cleanupErrors, requests, screenshots, failure: failure ? redact(failure) : null };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, checks: checks.length, requests: requests.length, report: join(out, "report.json"), failure: report.failure, cleanupErrors })); if (report.status !== "PASS") process.exitCode = 1;
  }
}
void main().catch(error => { console.error(redact(error)); process.exitCode = 1; });
