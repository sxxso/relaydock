import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as portProbe } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, type Page } from "playwright";
import { Store } from "../src/lib/store";
import Database from "better-sqlite3";
import { hashPassword } from "../src/lib/crypto";
import { QueryTrace, QueryFailure } from "../src/lib/query-trace";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

// Existing production build; isolated SQLite and explicit local HTTP fixture.
// Does not load/copy .env.local, use :3000, seed real data or enable DoH/proxy.
async function main() {
  const root = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "atlas-freshness-ui-"));
  const runtime = join(temp, "runtime");
  const out = join(
    root,
    "output",
    "playwright",
    "freshness",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(out, { recursive: true });
  const port = 3322,
    origin = `http://127.0.0.1:${port}`,
    password = "fixture-freshness-password-123",
    key = Buffer.alloc(32, 8);
  const redOnly = process.argv.includes("--red-only");
  const now = Date.now(),
    oldAt = new Date(now - 3 * 86400000).toISOString();
  let mode = "auth",
    hits = 0,
    logs = "",
    failure: unknown;
  const errors: string[] = [],
    cleanupErrors: string[] = [],
    passed: string[] = [],
    screenshots: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    page: Page | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  const fixture = createServer((req, res) => {
    hits++;
    if (req.headers.authorization !== "Bearer fixture-secret")
      errors.push("fixture credential mismatch");
    res.setHeader("Content-Type", "application/json");
    res.writeHead(mode === "auth" ? 401 : 200);
    res.end(
      JSON.stringify(
        mode === "auth" ? { error: "fixture-private-error" } : { balance: "0" },
      ),
    );
  });
  try {
    await new Promise<void>((done, reject) => {
      const probe = portProbe();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => done()));
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const address = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const input = {
      name: "有记录 · 最近超时",
      siteUrl: address,
      provider: "custom",
      unit: "USD",
      credential: "fixture-secret",
      query: { path: "/balance" },
      group: "常用",
    };
    const store = new Store(join(temp, "atlas.sqlite"), key);
    let account: ReturnType<Store["create"]>;
    try {
      store.setMeta("adminHash", hashPassword(password));
      account = store.create(input);
      store.record(account.id, "28.50", "sync", "USD", "隔离夹具");
      const zero = store.create({
        name: "手动零余额",
        siteUrl: "https://zero.fixture.example",
        initialBalance: "0",
        group: "手记",
      });
      store.create({
        name: "未知余额 · 很长的站点名称用来检查手机排版",
        siteUrl: "https://unknown.fixture.example",
        group: "手记",
      });
      const cny = store.create({
        name: "CNY 余额",
        siteUrl: "https://cny.fixture.example",
        unit: "CNY",
        initialBalance: "8",
        group: "常用",
      });
      const backup = store.exportBackup();
      backup.snapshots = backup.snapshots.map((s) => ({
        ...s,
        at:
          s.accountId === zero.id ? new Date(now - 59000).toISOString() : oldAt,
      }));
      store.importBackup(backup, false);
      const d = new QueryTrace({
        provider: "custom",
        operation: "sync",
        timeoutSeconds: 10,
        dnsMode: "system",
      }).finish(new QueryFailure("response_timeout", "fixture-private-error"));
      store.saveQueryDiagnostic(account.id, d);
      store.syncFailure(account.id, "等待响应超时", d);
      const legacy = new Database(join(temp, "atlas.sqlite"));
      try {
        legacy
          .prepare(
            "UPDATE accounts SET payload=json_set(payload,'$.lastSyncStatus','error','$.lastSyncError',?,'$.lastSyncAt',?) WHERE id=?",
          )
          .run(
            "https://legacy-private.invalid/?token=LEGACY_PRIVATE_SENTINEL",
            new Date(now).toISOString(),
            cny.id,
          );
      } finally {
        legacy.close();
      }
    } finally {
      store.close();
    }
    copyIsolatedBuild(root, runtime);
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
          NODE_ENV: "production",
          NEXT_TELEMETRY_DISABLED: "1",
          RELAYDOCK_DATA_DIR: temp,
          RELAYDOCK_VAULT_KEY: key.toString("hex"),
          RELAYDOCK_ADMIN_PASSWORD_HASH: hashPassword(password),
          RELAYDOCK_ADMIN_PASSWORD: "",
          RELAYDOCK_PUBLIC_URL: origin,
          RELAYDOCK_PRIVATE_HOSTS: "127.0.0.1",
          RELAYDOCK_DNS_MODE: "system",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout!.on("data", (b) => {
      logs += String(b);
    });
    server.stderr!.on("data", (b) => {
      logs += String(b);
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/api/auth/session")).ok) break;
      } catch {}
      assert.ok(i < 99, "isolated server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.launch({
      headless: true,
      env: cleanRuntimeEnv() as Record<string, string>,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    page = await context.newPage();
    const mapPage = page;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (new URL(r.url()).hostname !== "127.0.0.1")
        errors.push("unexpected browser destination");
    });
    await page.clock.install({ time: now + 2000 });
    await page.goto(origin);
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "进入我的群岛" }).click();
    await page.locator("[data-node]").first().waitFor();
    await mapIdle();
    await page.getByRole("button", { name: /有记录 · 最近超时/ }).click();
    const detail = page.getByRole("complementary", { name: "当前账号详情" });
    async function mapIdle() {
      await mapPage.evaluate(() => {
        delete (window as unknown as { freshnessMapStill?: unknown })
          .freshnessMapStill;
      });
      await mapPage.waitForFunction(() => {
        const svg = document.querySelector<SVGSVGElement>(".atlas-svg") as
          (SVGSVGElement & { __transition?: unknown }) | null;
        const map = document.querySelector('[data-testid="atlas-map"]');
        const world = document.querySelector('[data-testid="map-world"]');
        const host = window as unknown as {
          freshnessMapStill?: { stamp: string; frames: number };
        };
        if (
          !svg ||
          !world ||
          svg.__transition ||
          map?.getAttribute("data-panning") !== "false"
        ) {
          delete host.freshnessMapStill;
          return false;
        }
        const box = svg.getBoundingClientRect();
        const stamp =
          world.getAttribute("transform") + `|${box.width}|${box.height}`;
        const frames =
          host.freshnessMapStill?.stamp === stamp
            ? host.freshnessMapStill.frames + 1
            : 0;
        host.freshnessMapStill = { stamp, frames };
        return frames >= 6;
      });
    }
    await detail
      .locator('[data-testid="balance-freshness"]')
      .first()
      .waitFor({ timeout: 5000 });
    assert.match(await detail.innerText(), /接口查询[\s\S]*3 天前记录/);
    assert.match(await detail.innerText(), /上次余额/);
    assert.match(await detail.innerText(), /最近查询超时/);
    assert.equal(hits, 0);
    const labelWidths = await page
      .locator(".node-name")
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as SVGGraphicsElement).getBBox().width),
      );
    assert.ok(
      labelWidths.every((w) => w <= 110),
      "map names must fit between stable 116-unit node centers",
    );
    passed.push("真实快照来源、三天前时间和失败后的上次金额；初始打开无查询");
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /LEGACY_PRIVATE_SENTINEL|legacy-private\.invalid/,
    );
    if (redOnly) return;
    const session = await (
      await context.request.get(origin + "/api/auth/session")
    ).json();
    const api = async (path: string, method = "GET", data?: unknown) => {
      const res = await context.request.fetch(origin + "/api/" + path, {
        method,
        headers: { Origin: origin, "x-csrf-token": session.csrf },
        ...(data === undefined ? {} : { data }),
      });
      assert.ok(res.ok(), `${method} ${path}: ${res.status()}`);
      return res.json();
    };
    const state = async () => ({
      a: (await api("accounts")).accounts.find(
        (a: { id: string }) => a.id === account.id,
      ),
      snapshots: (await api("history")).snapshots.filter(
        (s: { accountId: string }) => s.accountId === account.id,
      ),
    });
    const before = await state();
    assert.ok(
      !JSON.stringify((await api("accounts")).accounts).includes(
        "LEGACY_PRIVATE_SENTINEL",
      ),
    );
    await page.getByRole("button", { name: "关闭账号详情" }).click();
    await detail.waitFor({ state: "hidden" });
    await mapIdle();
    await page
      .getByRole("button", { name: /CNY 余额/ })
      .first()
      .click();
    await detail.locator(".query-error").waitFor();
    assert.doesNotMatch(
      await detail.innerText(),
      /LEGACY_PRIVATE_SENTINEL|legacy-private\.invalid/,
    );
    passed.push("旧错误文本在 API 和实际详情 DOM 脱敏");
    await detail.getByRole("button", { name: "关闭账号详情" }).click();
    await detail.waitFor({ state: "hidden" });
    await mapIdle();
    await page
      .getByRole("button", { name: /有记录 · 最近超时/ })
      .first()
      .click();
    await detail.waitFor();
    await detail.getByRole("button", { name: "测试连接", exact: true }).click();
    await detail
      .locator(".freshness-test")
      .filter({ hasText: "连接测试被拒绝（401/403）（未更新余额）" })
      .waitFor();
    const tested = await state();
    assert.equal(tested.a.balance, before.a.balance);
    assert.equal(tested.a.balanceSource, "sync");
    assert.equal(tested.a.lastSnapshotAt, before.a.lastSnapshotAt);
    assert.equal(tested.a.lastSyncAt, before.a.lastSyncAt);
    assert.deepEqual(tested.snapshots, before.snapshots);
    assert.match(await detail.innerText(), /最近查询超时/);
    assert.equal(hits, 1);
    passed.push("真实失败连接测试不覆盖刷新超时、来源、金额与快照");
    await page.getByRole("button", { name: "列表视图" }).click();
    const row = page
      .locator(".site-row")
      .filter({ hasText: "有记录 · 最近超时" });
    assert.match(await row.innerText(), /接口查询[\s\S]*3 天前记录/);
    assert.match(await row.innerText(), /最近查询超时/);
    passed.push("地图与列表来源、时间、失败一致");
    // Real failed refresh, not a caption or a seeded status, proves retention.
    const beforeFailure = await state();
    await detail.getByRole("button", { name: "刷新余额", exact: true }).click();
    await detail
      .locator(".freshness-query-result")
      .filter({ hasText: "最近查询被拒绝（401/403）" })
      .waitFor();
    const afterFailure = await state();
    assert.equal(afterFailure.a.balance, beforeFailure.a.balance);
    assert.equal(afterFailure.a.balanceSource, beforeFailure.a.balanceSource);
    assert.equal(afterFailure.a.lastSnapshotAt, beforeFailure.a.lastSnapshotAt);
    assert.deepEqual(afterFailure.snapshots, beforeFailure.snapshots);
    assert.equal(hits, 2);
    passed.push("真实失败刷新保留金额、来源、时间与快照，无重试");
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      for (const theme of ["light", "dark"]) {
        await api("settings", "PATCH", {
          ...(await api("accounts")).settings,
          theme,
        });
        await page.reload();
        await page.locator("[data-node],.site-row").first().waitFor();
        if (width > 760)
          await page.getByRole("button", { name: "列表视图" }).click();
        const failedRow = page
          .locator(".site-row")
          .filter({ hasText: "有记录 · 最近超时" });
        await failedRow.locator(".site-identity").click();
        await detail
          .locator(".freshness-query-result")
          .filter({ hasText: "最近查询被拒绝（401/403）" })
          .waitFor();
        assert.match(await detail.innerText(), /最近查询被拒绝（401\/403）/);
        assert.match(await detail.innerText(), /接口查询[\s\S]*3 天前记录/);
        // tsx/esbuild injects naming helpers into nested functions. A literal
        // browser function keeps this calculation independent of Node helpers.
        const sourceContrast = await page.evaluate<{ color: string; background: number[]; ratio: number }>(String.raw`(() => {
          const el = document.querySelector('.account-detail .freshness-source');
          if (!el) throw new Error('Freshness source text is missing');
          const rgba = (value) => (value.match(/[\d.]+/g) || []).map(Number);
          const blend = (front, back) => {
            const alpha = front[3] ?? 1;
            return back.map((channel, i) => front[i] * alpha + channel * (1 - alpha));
          };
          const ancestors = [];
          for (let node = el.parentElement; node; node = node.parentElement) ancestors.unshift(node);
          let background = [255, 255, 255];
          for (const node of ancestors) background = blend(rgba(getComputedStyle(node).backgroundColor), background);
          const color = getComputedStyle(el).color;
          const foreground = blend(rgba(color), background);
          const luminance = (rgb) => rgb.map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
          const fg = luminance(foreground), bg = luminance(background);
          return { color, background, ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
        })()`);
        assert.ok(sourceContrast.ratio >= 4.5,
          `Freshness source text must remain readable at ${width}/${theme}: ${JSON.stringify(sourceContrast)}`);
        const overflow: boolean = await page.evaluate(
          "document.documentElement.scrollWidth > innerWidth + 1",
        );
        assert.equal(overflow, false);
        const file = `failure-detail-${theme}-${width}.png`;
        await page.evaluate(
          "Promise.all([...document.querySelectorAll('.account-detail')].flatMap(e => e.getAnimations({subtree:true})).map(a => a.finished.catch(() => {})))",
        );
        await page.screenshot({
          path: join(out, file),
          fullPage: true,
          animations: "disabled",
        });
        assert.equal(
          await detail.evaluate((el) => getComputedStyle(el).opacity),
          "1",
        );
        screenshots.push(file);
        await detail.getByRole("button", { name: "关闭账号详情" }).click();
        await detail.waitFor({ state: "hidden" });
        assert.ok(
          await failedRow
            .locator(
              width <= 1100
                ? ".list-amount .freshness-query-result"
                : ".balance-query-cell .freshness-query-result",
            )
            .isVisible(),
        );
      }
    }
    passed.push(
      "失败与测试状态在 375/768/1440 浅深主题可见，详情来源/日期对比度正常",
    );
    await page.setViewportSize({ width: 1440, height: 960 });
    await page
      .locator(".site-identity")
      .filter({ hasText: "有记录 · 最近超时" })
      .click();
    await detail.waitFor();
    await detail.getByRole("button", { name: "记录余额", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("余额 / USD").fill("17.75");
    await dialog.getByRole("button", { name: "保存记录" }).click();
    await dialog.waitFor({ state: "hidden" });
    await detail
      .locator(".freshness-source")
      .filter({ hasText: "手动记录" })
      .waitFor();
    assert.match(await detail.innerText(), /手动记录/);
    assert.match(await detail.innerText(), /最近查询被拒绝（401\/403）/);
    assert.equal((await state()).a.balance, "17.75");
    assert.equal(hits, 2);
    passed.push("手动修正立即更新来源，不清除上次刷新失败也不查询");
    mode = "zero";
    await detail.getByRole("button", { name: "刷新余额", exact: true }).click();
    await detail.getByText("最近查询成功", { exact: true }).waitFor();
    const refreshed = await state();
    assert.equal(refreshed.a.balance, "0");
    assert.equal(refreshed.a.balanceSource, "sync");
    assert.equal(refreshed.snapshots.length, before.snapshots.length + 2);
    assert.doesNotMatch(await detail.innerText(), /最近查询超时/);
    assert.doesNotMatch(await detail.innerText(), /最近查询被拒绝/);
    assert.equal(hits, 3);
    passed.push("显式刷新写入接口零余额和真实快照、清除刷新失败");
    await detail.getByRole("button", { name: "关闭账号详情" }).click();
    await detail.waitFor({ state: "hidden" });
    const zeroRow = page.locator(".site-row").filter({ hasText: "手动零余额" });
    const unknown = page.locator(".site-row").filter({ hasText: "未知余额" });
    assert.match(await zeroRow.innerText(), /手动记录/);
    assert.match(await unknown.innerText(), /尚无余额记录/);
    assert.equal(await unknown.locator("time[datetime]").count(), 0);
    const oldAge = await zeroRow.locator(".freshness-age").innerText();
    await page.clock.fastForward(61000);
    assert.notEqual(
      await zeroRow.locator(".freshness-age").innerText(),
      oldAge,
    );
    assert.equal(hits, 3);
    passed.push("零/未知明确分离，单个分钟时钟更新时间而无网络查询");
    assert.ok(
      await zeroRow.locator("time[datetime][aria-label][title]").count(),
    );
    const backup = await api("backup/export");
    assert.ok(!JSON.stringify(backup).includes("Diagnostic"));
    passed.push("绝对日期可访问；备份含来源快照而不含诊断");
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 960 });
      for (const theme of ["light", "dark"] as const) {
        await api("settings", "PATCH", {
          ...(await api("accounts")).settings,
          theme,
        });
        await page.reload();
        await page.locator("[data-node],.site-row").first().waitFor();
        if (width > 760)
          await page.getByRole("button", { name: "列表视图" }).click();
        await page.locator(".site-row").first().waitFor();
        const overflow: boolean = await page.evaluate(
          "document.documentElement.scrollWidth > innerWidth + 1",
        );
        assert.equal(overflow, false, `overflow ${width} ${theme}`);
        if (width <= 1100) {
          const failedRow = page
            .locator(".site-row")
            .filter({ hasText: "有记录 · 最近超时" });
          assert.ok(
            await failedRow
              .locator(".list-amount .freshness-query")
              .isVisible(),
          );
        }
        const file = `list-${theme}-${width}.png`;
        await page.screenshot({
          path: join(out, file),
          fullPage: true,
          animations: "disabled",
        });
        screenshots.push(file);
        await page
          .locator(".site-identity")
          .filter({ hasText: "有记录 · 最近超时" })
          .click();
        const date = page
          .getByRole("complementary", { name: "当前账号详情" })
          .locator("time[datetime]")
          .first();
        assert.ok(await date.getAttribute("aria-label"));
        const detailFile = `detail-${theme}-${width}.png`;
        await page.evaluate(
          "Promise.all([...document.querySelectorAll('.account-detail')].flatMap(e => e.getAnimations({subtree:true})).map(a => a.finished.catch(() => {})))",
        );
        await page.screenshot({
          path: join(out, detailFile),
          fullPage: true,
          animations: "disabled",
        });
        assert.equal(
          await detail.evaluate((el) => getComputedStyle(el).opacity),
          "1",
        );
        screenshots.push(detailFile);
        await page.getByRole("button", { name: "关闭账号详情" }).click();
        await page
          .getByRole("complementary", { name: "当前账号详情" })
          .waitFor({ state: "hidden" });
      }
    }
    passed.push(
      "375/768/1440 浅深主题：无横向溢出，手机状态不被隐藏，绝对日期可访问",
    );
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "地图视图" }).click();
    // Await the initial fit before taking the clock-stability baseline.
    await page.clock.runFor(100);
    await page.waitForFunction(
      "document.querySelector('svg.atlas-svg > g')?.getAttribute('transform') != null",
    );
    const positions = async () =>
      page!
        .locator("[data-node]")
        .evaluateAll((nodes) =>
          nodes.map((n) => [
            n.getAttribute("transform"),
            n.getAttribute("aria-label"),
          ]),
        );
    const firstPositions = (await positions()).map((p) => p[0]);
    const camera = await page
      .locator("svg.atlas-svg > g")
      .getAttribute("transform");
    await page.clock.fastForward(60000);
    assert.deepEqual(
      (await positions()).map((p) => p[0]),
      firstPositions,
    );
    assert.equal(
      await page.locator("svg.atlas-svg > g").getAttribute("transform"),
      camera,
    );
    assert.match(
      (await page
        .getByRole("button", { name: /有记录 · 最近超时/ })
        .getAttribute("aria-label")) || "",
      /接口查询/,
    );
    await page.screenshot({
      path: join(out, "map-reduced.png"),
      fullPage: true,
      animations: "disabled",
    });
    screenshots.push("map-reduced.png");
    passed.push("地图时钟更新不移动节点；减少动效仍可用");
    for (let i = 4; i < 50; i++)
      await api("accounts", "POST", {
        name: "布局夹具 " + i,
        siteUrl: "https://layout.fixture.example",
        group: "分组 " + (i % 4),
        initialBalance: i % 2 ? "0" : null,
      });
    await page.reload();
    await page.locator("[data-node]").last().waitFor();
    assert.equal(await page.locator("[data-node]").count(), 50);
    const fiftyPositions = (await positions()).map((p) => p[0]);
    await page.clock.fastForward(61000);
    assert.deepEqual(
      (await positions()).map((p) => p[0]),
      fiftyPositions,
    );
    await page.screenshot({
      path: join(out, "fifty-accounts.png"),
      fullPage: true,
      animations: "disabled",
    });
    screenshots.push("fifty-accounts.png");
    passed.push("50 账号稳定节点布局，等待与导航均不查询");
    assert.equal(hits, 3);
    assert.deepEqual(errors, []);
  } catch (e) {
    failure = e;
    if (page)
      try {
        await page.screenshot({
          path: join(out, "failure.png"),
          fullPage: true,
        });
        writeFileSync(
          join(out, "failure-dom.txt"),
          await page.locator("body").innerText(),
        );
      } catch {}
  } finally {
    try {
      await browser?.close();
    } catch {
      cleanupErrors.push("browser cleanup");
    }
    if (server) {
      const child = server;
      const ended = new Promise<void>((r) => child.once("exit", () => r()));
      if (child.exitCode === null) {
        child.kill();
        await ended;
      }
    }
    fixture.closeAllConnections();
    if (fixture.listening)
      await new Promise<void>((r) => fixture.close(() => r()));
    try {
      assert.ok(
        resolve(temp).startsWith(
          resolve(tmpdir()) + sep + "atlas-freshness-ui-",
        ),
      );
      assert.equal(resolve(runtime), join(resolve(temp), "runtime"));
      if (existsSync(join(runtime, "node_modules")))
        unlinkSync(join(runtime, "node_modules"));
      rmSync(temp, { recursive: true, force: true });
    } catch {
      cleanupErrors.push("isolated DB cleanup");
    }
    writeFileSync(join(out, "server-log.txt"), logs);
    writeFileSync(
      join(out, "verification.json"),
      JSON.stringify(
        {
          status: failure
            ? redOnly
              ? "RED"
              : "FAIL"
            : redOnly
              ? "SMOKE_ONLY"
              : cleanupErrors.length
                ? "FAIL"
                : "PASS",
          buildId: readFileSync(join(root, ".next", "BUILD_ID"), "utf8").trim(),
          passed,
          fixtureRequests: hits,
          errors,
          cleanupErrors,
          screenshots,
          failure:
            failure instanceof Error
              ? failure.message
              : failure
                ? String(failure)
                : null,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        out,
        passed: passed.length,
        fixtureRequests: hits,
        errors,
        cleanupErrors,
      }),
    );
  }
  if (failure) throw failure;
  assert.deepEqual(cleanupErrors, []);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
