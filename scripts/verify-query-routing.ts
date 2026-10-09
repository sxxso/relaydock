import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { chromium, type Browser, type Page } from "playwright";
import { Store } from "../src/lib/store";
import { hashPassword } from "../src/lib/crypto";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

// Only a copied production build, synthetic SQLite data and loopback fixtures.
// No .env.local, actual provider token, system proxy or port 3000 is used.
async function main() {
  const root = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "atlas-route-ui-")),
    runtime = join(temp, "runtime");
  const out = join(
    root,
    "output/playwright/query-routing",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(out, { recursive: true });
  const key = Buffer.alloc(32, 28),
    password = "isolated-query-routing-fixture";
  const passed: string[] = [],
    errors: string[] = [],
    requests: { operation: string; routeMode: unknown }[] = [];
  const sockets = new Set<Duplex>(),
    pending: ServerResponse[] = [];
  let hits = 0,
    tunnels = 0,
    hold = false,
    logs = "",
    failure: unknown;
  let server: ReturnType<typeof spawn> | undefined,
    browser: Browser | undefined,
    page: Page | undefined;
  const answer = (res: ServerResponse, bad = false) => {
    res.writeHead(bad ? 503 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        bad
          ? { error: "synthetic failure" }
          : { success: true, data: { quota: 1250000, used_quota: 500000 } },
      ),
    );
  };
  const provider = createServer((req, res) => {
    hits++;
    if (
      req.headers.authorization !== "Bearer routing-ui-key" ||
      req.headers["proxy-authorization"]
    )
      errors.push("fixture authentication separation failed");
    hold ? pending.push(res) : answer(res);
  });
  const proxy = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  const listen = (s: ReturnType<typeof createServer>) =>
    new Promise<number>((r, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port));
    });
  const until = async (f: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.fail("Fixture condition timed out");
  };
  const stop = async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise<void>((r) => server!.once("exit", () => r()));
      server.kill();
      await exited;
    }
  };
  try {
    const providerPort = await listen(provider);
    proxy.on("connect", (req, client, head) => {
      tunnels++;
      assert.equal(req.url, `127.0.0.1:${providerPort}`);
      assert.equal(req.headers.authorization, undefined);
      assert.equal(
        req.headers["proxy-authorization"],
        "Basic " +
          Buffer.from("fixture:routing-ui-proxy-secret").toString("base64"),
      );
      const upstream = connect(providerPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
        s.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.on("close", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy),
      probe = createServer(),
      port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    const origin = `http://127.0.0.1:${port}`;
    const store = new Store(join(temp, "atlas.sqlite"), key);
    try {
      store.setMeta("adminHash", hashPassword(password));
      for (let i = 0; i < 5; i++)
        store.create({
          name: `查询夹具 ${i + 1}`,
          siteUrl: `http://127.0.0.1:${providerPort}`,
          provider: "newapi",
          credential: "routing-ui-key",
          userId: "123",
          quotaPerUnit: "500000",
          unit: "USD",
          initialBalance: "7",
          group: i < 3 ? "常用平台" : "备用平台",
        });
    } finally {
      store.close();
    }
    copyIsolatedBuild(root, runtime);
    const buildId = readFileSync(
      join(runtime, ".next/BUILD_ID"),
      "utf8",
    ).trim();
    const start = async (configured: boolean) => {
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
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...cleanRuntimeEnv(),
            NEXT_TELEMETRY_DISABLED: "1",
            RELAYDOCK_DATA_DIR: temp,
            RELAYDOCK_VAULT_KEY: key.toString("hex"),
            RELAYDOCK_PUBLIC_URL: origin,
            RELAYDOCK_DNS_MODE: "system",
            RELAYDOCK_PRIVATE_HOSTS: "127.0.0.1",
            ...(configured
              ? {
                  RELAYDOCK_QUERY_PROXY_URL: `http://fixture:routing-ui-proxy-secret@127.0.0.1:${proxyPort}`,
                }
              : {}),
          },
        },
      );
      server.stdout!.on("data", (b) => (logs += String(b)));
      server.stderr!.on("data", (b) => (logs += String(b)));
      await until(async () => {
        assert.equal(server!.exitCode, null);
        try {
          return (await fetch(origin + "/api/auth/session")).ok;
        } catch {
          return false;
        }
      });
    };
    await start(true);
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname !== "127.0.0.1")
        errors.push("unexpected remote browser request");
      if (
        /\/api\/accounts\/[^/]+\/(sync|test)$/.test(url.pathname) ||
        url.pathname === "/api/query/test"
      )
        requests.push({
          operation: url.pathname.split("/").at(-1)!,
          routeMode: req.postDataJSON()?.routeMode,
        });
    });
    const routeButton = (mode: "direct" | "proxy") =>
      page!.getByTestId("query-route-" + mode);
    const selected = (mode: "direct" | "proxy") =>
      until(
        async () =>
          (await routeButton(mode).getAttribute("aria-pressed")) === "true" &&
          !(await routeButton("direct").isDisabled()),
      );
    const change = async (mode: "direct" | "proxy") => {
      await routeButton(mode).click();
      await selected(mode);
    };
    const api = async (path: string, method = "GET", data?: unknown) => {
      const session = await (
        await context.request.get(origin + "/api/auth/session")
      ).json();
      const res = await context.request.fetch(origin + "/api/" + path, {
        method,
        data,
        headers: { origin, "x-csrf-token": session.csrf },
      });
      assert.equal(res.ok(), true, "fixture API failed: " + path);
      return await res.json();
    };
    const chooseFirst = async () => {
      await page!.getByLabel("列表视图", { exact: true }).click();
      await page!
        .getByRole("button", { name: "查看 查询夹具 1", exact: true })
        .click();
    };
    await page.goto(origin);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "进入我的群岛" }).click();
    await selected("proxy");
    assert.equal(hits, 0);
    assert.equal(tunnels, 0);
    passed.push(
      "existing proxy default preserved; initial load sends no provider request",
    );
    await change("direct");
    await page.reload();
    await selected("direct");
    assert.equal(hits, 0);
    assert.equal(tunnels, 0);
    passed.push("direct selection persists across reload without querying");
    await chooseFirst();
    let response = page.waitForResponse((r) =>
      /\/accounts\/[^/]+\/test$/.test(r.url()),
    );
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    assert.equal(
      (await (await response).json()).diagnostic.routeMode,
      "direct",
    );
    await until(
      async () =>
        !(await page!
          .getByRole("button", { name: "测试连接", exact: true })
          .isDisabled()),
    );
    assert.equal(tunnels, 0);
    await page.locator(".query-diagnostic summary").click();
    assert.match(
      await page.locator(".diagnostic-footnote").innerText(),
      /直连线路/,
    );
    passed.push(
      "single direct test uses direct transport and truthful diagnostic",
    );
    await routeButton("proxy").focus();
    await routeButton("proxy").press("Enter");
    await selected("proxy");
    response = page.waitForResponse((r) =>
      /\/accounts\/[^/]+\/test$/.test(r.url()),
    );
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    assert.equal((await (await response).json()).diagnostic.routeMode, "proxy");
    await until(
      async () =>
        !(await page!
          .getByRole("button", { name: "测试连接", exact: true })
          .isDisabled()),
    );
    assert.equal(tunnels, 1);
    await page.locator(".query-diagnostic summary").click();
    assert.match(
      await page.locator(".diagnostic-footnote").innerText(),
      /代理线路/,
    );
    passed.push(
      "keyboard proxy selection and single test use CONNECT; tests do not write balances",
    );
    assert.ok(
      (await api("accounts")).accounts.every(
        (a: { balance: string }) => a.balance === "7",
      ),
    );

    await page.getByLabel("关闭账号详情").click();
    const beforeHits = hits,
      beforeTunnels = tunnels,
      beforeRequests = requests.length;
    hold = true;
    await page.locator(".query-tools .refresh-button").click();
    await until(() => pending.length === 3);
    assert.equal(await routeButton("direct").isDisabled(), true);
    await api("query/routing", "POST", { mode: "direct" }); // another client changes server preference mid-batch
    hold = false;
    pending.splice(0).forEach((res, i) => answer(res, i === 0));
    await until(
      async () =>
        !(await page!.locator(".query-tools .refresh-button").isDisabled()),
    );
    assert.equal(hits - beforeHits, 5);
    assert.equal(tunnels - beforeTunnels, 5);
    assert.ok(
      requests.slice(beforeRequests).every((r) => r.routeMode === "proxy"),
    );
    const afterBatch = (await api("accounts")).accounts;
    assert.equal(
      afterBatch.filter(
        (a: { lastSyncStatus: string; balance: string }) =>
          a.lastSyncStatus === "error" && a.balance === "7",
      ).length,
      1,
    );
    passed.push(
      "batch captures one route for all workers despite other client/save and failed-query reload; failed balance preserved",
    );
    await page.reload();
    await selected("direct");
    await chooseFirst();

    // Simulate a slow stale accounts read started before a successful route save.
    let held = false,
      delivered = false,
      releaseRead!: () => void;
    const gate = new Promise<void>((r) => (releaseRead = r));
    await page.route("**/api/accounts", async (route) => {
      const res = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response: res });
      delivered = true;
    });
    await page.getByRole("button", { name: "记录余额", exact: true }).click();
    await page.locator('input[name="amount"]').fill("9");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await until(() => held);
    await change("proxy");
    releaseRead();
    await until(() => delivered);
    await page.unroute("**/api/accounts");
    await page.waitForTimeout(350);
    assert.equal(
      await routeButton("proxy").getAttribute("aria-pressed"),
      "true",
    );
    passed.push("slow stale account load cannot undo a newer route choice");
    const count = hits;
    await page.route("**/api/query/routing", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "夹具保存失败" }),
          })
        : route.continue(),
    );
    await routeButton("direct").click();
    await page
      .getByRole("status")
      .filter({ hasText: "夹具保存失败" })
      .waitFor();
    assert.equal(
      await routeButton("proxy").getAttribute("aria-pressed"),
      "true",
    );
    await page.unroute("**/api/query/routing");
    assert.equal((await api("query/routing")).mode, "proxy");
    assert.equal(hits, count);
    passed.push("failed save keeps previous choice and makes no query");

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const section = page.getByTestId("query-routing-settings");
    await section.waitFor();
    await change("direct");
    assert.match(await section.innerText(), /不代表网络已连通/);
    await page.getByRole("button", { name: "站点", exact: true }).click();
    await selected("direct");
    assert.equal(hits, count);
    passed.push(
      "settings and toolbar share route selection; navigation/toggle never query",
    );
    if (await page.getByLabel("关闭账号详情").count())
      await page.getByLabel("关闭账号详情").click();
    await page.getByLabel("地图视图", { exact: true }).click();
    const capture = async (name: string, width: number, dark: boolean) => {
      await page!.setViewportSize({
        width,
        height: width === 375 ? 812 : 1000,
      });
      const themeToggle = page!.getByRole("button", {
        name: dark ? "切换到深色" : "切换到浅色",
        exact: true,
      });
      if (await themeToggle.count()) await themeToggle.click();
      await until(
        async () =>
          (await page!.locator("html").getAttribute("data-theme")) ===
          (dark ? "dark" : "light"),
      );
      if (width === 375)
        await page!.getByLabel("列表视图", { exact: true }).click();
      await page!.waitForTimeout(180);
      assert.ok(
        await page!.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "page overflow",
      );
      for (const mode of ["direct", "proxy"] as const) {
        const box = await routeButton(mode).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
      }
      if (width === 375) {
        const viewBox = await page!.locator(".view-switch").boundingBox();
        const routeBox = await routeButton("direct").boundingBox();
        assert.ok(
          viewBox && routeBox && Math.abs(viewBox.y - routeBox.y) < 8,
          "mobile view and query tools should share one compact row",
        );
      }
      await page!.screenshot({
        path: join(out, name + ".png"),
        fullPage: true,
      });
    };
    await capture("desktop-light", 1440, false);
    await capture("tablet-dark", 768, true);
    await capture("mobile-light", 375, false);
    await capture("mobile-dark", 375, true);
    // Global accessibility CSS uses a one-microsecond duration rather than zero.
    const duration = await routeButton("direct").evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    );
    assert.ok(
      duration.split(",").every((value) => parseFloat(value) <= 0.000001),
    );
    passed.push(
      "1440/768/375 light/dark screenshots, no overflow and reduced motion honored",
    );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: join(out, "settings-mobile-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: join(out, "settings-desktop-dark.png"),
      fullPage: true,
    });
    passed.push(
      "settings explanation remains readable on desktop and phone; no proxy URL disclosed",
    );
    await change("proxy");
    const idleHits = hits;
    await page.waitForTimeout(700);
    assert.equal(hits, idleHits);
    await stop();
    await start(false);
    await page.reload();
    await until(
      async () =>
        (await routeButton("proxy").getAttribute("aria-pressed")) === "true",
    );
    assert.equal(await routeButton("proxy").isDisabled(), true);
    await change("direct");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.match(
      await page.getByTestId("query-routing-settings").innerText(),
      /代理未配置/,
    );
    assert.equal(hits, idleHits);
    passed.push(
      "restart preserves choice; missing proxy disables proxy without silent direct fallback; direct recovery works",
    );
    assert.deepEqual(errors, []);
    writeFileSync(join(out, "build-id.txt"), buildId);
  } catch (error) {
    failure = error;
  } finally {
    if (failure && page) {
      await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
      writeFileSync(
        join(out, "failure-dom.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
    }
    await browser?.close();
    await stop();
    for (const res of pending.splice(0)) res.destroy();
    for (const s of sockets) s.destroy();
    for (const s of [provider, proxy]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith("atlas-route-ui-"));
    assert.equal(resolve(runtime), join(resolve(temp), "runtime"));
    if (existsSync(join(runtime, "node_modules")))
      unlinkSync(join(runtime, "node_modules"));
    rmSync(temp, { recursive: true, force: true });
    writeFileSync(join(out, "server-log.txt"), logs);
    writeFileSync(
      join(out, "verification.json"),
      JSON.stringify(
        {
          status: failure ? "FAIL" : "PASS",
          isolated: true,
          realUserDataTouched: false,
          passed,
          hits,
          tunnels,
          requests,
          errors,
          failure: failure instanceof Error ? failure.message : null,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ out, passed, hits, tunnels, errors }));
  }
  if (failure) throw failure;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
