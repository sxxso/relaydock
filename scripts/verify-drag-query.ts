import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { chromium, type Browser } from "playwright";
import { Store } from "../src/lib/store";
import { hashPassword } from "../src/lib/crypto";
import type { Account } from "../src/lib/validation";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

async function main() {
  const root = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "atlas-drag-query-")),
    runtime = join(temp, "runtime");
  const out = join(
    root,
    "output",
    "playwright",
    "drag-query",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(out, { recursive: true });
  const key = Buffer.alloc(32, 21),
    password = "isolated-drag-query-fixture";
  const passed: string[] = [],
    errors: string[] = [],
    observed: unknown[] = [],
    fixtures: Account[] = [];
  const sockets = new Set<Duplex>();
  let queries = 0,
    connects = 0,
    moves = 0,
    buildId = "",
    logs = "",
    failure: unknown,
    browser: Browser | undefined,
    server: ReturnType<typeof spawn> | undefined;
  let inactive = false;
  const provider = createServer((req, res) => {
    queries++;
    observed.push({
      path: req.url,
      userId: req.headers["new-api-user"],
      ua: req.headers["user-agent"],
      hasProviderAuth: req.headers.authorization === "Bearer fixture-query-key",
      hasProxyAuth: !!req.headers["proxy-authorization"],
    });
    assert.equal(req.headers.authorization, "Bearer fixture-query-key");
    assert.equal(req.headers["proxy-authorization"], undefined);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/user/self"
          ? {
              success: true,
              data: { quota: 625000, used_quota: 125000, group: "fixture" },
            }
          : {
              remaining: null,
              quota: { remaining: "28.50", unit: "CNY" },
              is_active: !inactive,
            },
      ),
    );
  });
  const proxy = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on("connect", (req, client, head) => {
    connects++;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(
      req.headers["proxy-authorization"],
      "Basic " + Buffer.from("fixture:proxy-secret").toString("base64"),
    );
    assert.match(req.url || "", /^127\.0\.0\.1:\d+$/);
    const port = Number(req.url!.split(":")[1]);
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    sockets.add(client);
    upstream.on("close", () => sockets.delete(upstream));
    client.on("close", () => sockets.delete(client));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  const listen = async (s: ReturnType<typeof createServer>) =>
    new Promise<number>((r, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port));
    });
  try {
    const providerPort = await listen(provider),
      proxyPort = await listen(proxy);
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    const origin = `http://127.0.0.1:${port}`;
    const store = new Store(join(temp, "atlas.sqlite"), key);
    try {
      store.setMeta("adminHash", hashPassword(password));
      for (let i = 0; i < 6; i++)
        fixtures.push(
          store.create({
            name: `站点 ${i + 1}`,
            siteUrl: "https://fixture.invalid",
            group: i < 4 ? "常用" : "备用",
            initialBalance: "12.34",
          }),
        );
      fixtures.push(
        store.create({
          name: "Usage 查询夹具",
          siteUrl: `http://127.0.0.1:${providerPort}`,
          group: "查询",
          provider: "custom",
          credential: "fixture-query-key",
          query: { path: "/v1/usage", extractionMode: "usage" },
          unit: "USD",
          initialBalance: "8",
        }),
      );
      fixtures.push(
        store.create({
          name: "New API 查询夹具",
          siteUrl: `http://127.0.0.1:${providerPort}`,
          group: "查询",
          provider: "newapi",
          credential: "fixture-query-key",
          userId: "123",
          quotaPerUnit: "500000",
          unit: "USD",
          initialBalance: "8",
        }),
      );
      for (let i = 0; i < 9; i++)
        fixtures.push(
          store.create({
            name: `大岛站点 ${i + 1}`,
            siteUrl: "https://fixture.invalid",
            group: "大岛",
            initialBalance: "1",
          }),
        );
    } finally {
      store.close();
    }
    copyIsolatedBuild(root, runtime);
    buildId = readFileSync(join(runtime, ".next", "BUILD_ID"), "utf8").trim();
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
          RELAYDOCK_QUERY_PROXY_URL: `http://fixture:proxy-secret@127.0.0.1:${proxyPort}`,
        },
      },
    );
    server.stdout!.on("data", (b) => (logs += String(b)));
    server.stderr!.on("data", (b) => (logs += String(b)));
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(origin + "/api/auth/session")).ok) break;
      } catch {}
      assert.ok(i < 100 && server.exitCode === null);
      await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (req) => {
      if (new URL(req.url()).hostname !== "127.0.0.1")
        errors.push("external browser request");
      if (req.url().endsWith("/accounts/move")) moves++;
    });
    await page.goto(origin);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "进入我的群岛" }).click();
    await page.locator("[data-account-id]").first().waitFor();
    const list = async (): Promise<Account[]> =>
      (await (await context.request.get(origin + "/api/accounts")).json())
        .accounts;
    const order = async (group: string) =>
      (await list())
        .filter((a) => a.group === group)
        .sort(
          (a, b) =>
            (a.mapOrder ?? 0) - (b.mapOrder ?? 0) || a.id.localeCompare(b.id),
        )
        .map((a) => a.id);
    const settleCamera = async () => {
      let previous = "", stable = 0;
      const started = Date.now();
      while (Date.now() - started < 5000 && stable < 8) {
        const transform = await page.getByTestId("map-world").getAttribute("transform") || "";
        stable = transform && transform === previous ? stable + 1 : 0;
        previous = transform;
        if (stable < 8) await page.waitForTimeout(40);
      }
      assert.ok(stable >= 8, "Map camera must settle before measuring a drag destination");
    };
    const point = async (id: string) => {
      const box = await page
        .locator(`[data-account-id="${id}"] .node-core`)
        .boundingBox();
      assert.ok(box);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const drag = async (id: string, to: { x: number; y: number }) => {
      const from = await point(id);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 16 });
      await page.mouse.up();
    };
    const initial = await list();
    assert.equal(queries, 0);
    passed.push(
      "initial load: no background query; proxy config is not itself a query",
    );
    const titles = await page
      .locator("[data-group-title]")
      .evaluateAll((elements) =>
        elements.map((e) => ({
          name: e.getAttribute("data-group-title"),
          anchor: e.getAttribute("text-anchor"),
        })),
      );
    assert.ok(titles.length >= 3);
    assert.ok(titles.every((t) => t.anchor === "middle"));
    passed.push("group titles centered inside islands");
    const before = await order("常用");
    await settleCamera();
    const first = await point(before[0]);
    await drag(before.at(-1)!, { x: first.x - 20, y: first.y });
    await page.waitForFunction(
      async ({ origin, id }) =>
        (await (await fetch(origin + "/api/accounts")).json()).accounts.find(
          (a: { id: string; mapOrder: number }) => a.id === id,
        )?.mapOrder === 0,
      { origin, id: before.at(-1)! },
    );
    assert.equal((await order("常用"))[0], before.at(-1));
    passed.push("mouse drag: within-group insertion persisted");
    await page.getByRole("button", { name: "显示全部站点" }).click();
    await settleCamera();
    const anchor = await point(fixtures[4].id);
    await drag(fixtures[0].id, { x: anchor.x - 18, y: anchor.y });
    await page.waitForFunction(
      async ({ origin, id }) =>
        (await (await fetch(origin + "/api/accounts")).json()).accounts.find(
          (a: { id: string; group: string }) => a.id === id,
        )?.group === "备用",
      { origin, id: fixtures[0].id },
    );
    assert.equal((await order("备用"))[0], fixtures[0].id);
    passed.push("cross-island drag changes group and order");
    assert.deepEqual(
      (await list())
        .map((a) => [a.id, a.balance, a.balanceUnit, a.balanceSnapshotId])
        .sort(),
      initial
        .map((a) => [a.id, a.balance, a.balanceUnit, a.balanceSnapshotId])
        .sort(),
    );
    passed.push(
      "moves preserve balances, original units and snapshot references",
    );
    const beforeCancel = moves,
      from = await point(fixtures[2].id);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 45, from.y + 25);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
    await page.mouse.move(from.x, from.y);
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(moves, beforeCancel);
    assert.equal(
      await page.getByRole("button", { name: "关闭账号详情" }).count(),
      0,
    );
    passed.push(
      "Escape cancels the held gesture after 1s; no write or accidental details",
    );
    const saved = await order("备用");
    await page.reload();
    await page.locator("[data-account-id]").first().waitFor();
    assert.deepEqual(await order("备用"), saved);
    passed.push("reload keeps explicit ordering");
    await page
      .getByRole("button", { name: "聚焦分组 大岛", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "放大地图" }).click();
    await settleCamera();
    const largeBounds = await page
      .getByRole("group", {
        name: "按分组展示的站点群岛，可缩放与平移",
        exact: true,
      })
      .boundingBox();
    assert.ok(largeBounds);
    const midIsland = await point(fixtures[12].id),
      beforeViewportDrop = moves;
    await drag(fixtures[12].id, {
      x: midIsland.x,
      y: largeBounds.y + largeBounds.height + 8,
    });
    await page.waitForTimeout(150);
    assert.equal(moves, beforeViewportDrop);
    passed.push(
      "captured pointer released outside SVG is rejected even over the world-space island",
    );
    await page.getByRole("button", { name: "显示全部站点" }).click();
    await page.waitForTimeout(150);
    const map = page.getByTestId("atlas-map"),
      world = page.getByTestId("map-world");
    const svgBox = await page
      .getByRole("group", {
        name: "按分组展示的站点群岛，可缩放与平移",
        exact: true,
      })
      .boundingBox();
    assert.ok(svgBox);
    const cameraBeforeOutside = await world.getAttribute("transform"),
      writesBeforeOutside = moves;
    await drag(fixtures[2].id, {
      x: svgBox.x + 8,
      y: svgBox.y + svgBox.height / 2,
    });
    await page.waitForTimeout(120);
    assert.equal(moves, writesBeforeOutside);
    assert.equal(await world.getAttribute("transform"), cameraBeforeOutside);
    passed.push("outside-island drop cancels without panning or saving");
    await page.mouse.move(svgBox.x + 8, svgBox.y + svgBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(svgBox.x + 48, svgBox.y + svgBox.height / 2 + 25, {
      steps: 10,
    });
    await page.mouse.up();
    await page.waitForTimeout(120);
    assert.notEqual(await world.getAttribute("transform"), cameraBeforeOutside);
    assert.equal(moves, writesBeforeOutside);
    passed.push("blank-space drag remains camera pan, not a site move");
    await page.getByRole("button", { name: "放大地图" }).click();
    await page.waitForTimeout(160);
    const scaledOrder = await order("常用"),
      scaledTarget = await point(scaledOrder[0]);
    await drag(scaledOrder.at(-1)!, {
      x: scaledTarget.x - 18,
      y: scaledTarget.y,
    });
    await page.waitForFunction(
      async ({ origin, id }) =>
        (await (await fetch(origin + "/api/accounts")).json()).accounts.find(
          (a: { id: string; mapOrder: number }) => a.id === id,
        )?.mapOrder === 0,
      { origin, id: scaledOrder.at(-1)! },
    );
    assert.equal((await order("常用"))[0], scaledOrder.at(-1));
    passed.push("drag after zoom/pan projects to the correct insertion slot");
    const keyboardId = fixtures[1].id;
    await page.locator(`[data-account-id="${keyboardId}"]`).focus();
    await page.keyboard.press("Alt+m");
    const movePanel = page.getByTestId("map-move-panel");
    await movePanel.waitFor();
    await movePanel.getByRole("combobox", { name: "移动目标分组" }).focus();
    await page.keyboard.press("Space");
    const standby = page.getByRole("option", { name: /^备用/ });
    await standby.waitFor();
    await standby.focus();
    await page.keyboard.press("Enter");
    await movePanel.getByRole("combobox", { name: "移动插入位置" }).focus();
    await page.keyboard.press("Space");
    const append = page.getByRole("option", { name: /^分组末尾/ });
    await append.waitFor();
    await append.focus();
    await page.keyboard.press("Enter");
    await movePanel
      .getByRole("button", { name: "保存位置", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await movePanel.waitFor({ state: "hidden" });
    assert.equal((await order("备用")).at(-1), keyboardId);
    passed.push(
      "Alt+M keyboard move uses custom dropdowns and saves group/order",
    );
    await page.getByRole("button", { name: "显示全部站点" }).click();
    if (await page.getByRole("button", { name: "关闭账号详情" }).count())
      await page.getByRole("button", { name: "关闭账号详情" }).click();
    await page.screenshot({
      path: join(out, "map-light-1440.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "列表视图" }).click();
    // Query through real production API, not mocked browser transport.
    const session = await (
      await context.request.get(origin + "/api/auth/session")
    ).json();
    const sync = async (id: string) =>
      context.request.post(origin + `/api/accounts/${id}/sync`, {
        headers: { origin, "x-csrf-token": session.csrf },
      });
    const usageRes = await sync(fixtures[6].id);
    assert.equal(usageRes.status(), 200);
    assert.equal((await usageRes.json()).balance, "28.5");
    assert.equal(
      (await list()).find((a) => a.id === fixtures[6].id)?.balanceUnit,
      "CNY",
    );
    const newApiRes = await sync(fixtures[7].id);
    assert.equal(newApiRes.status(), 200);
    assert.equal((await newApiRes.json()).balance, "1.25");
    assert.equal(queries, 2);
    assert.equal(connects, 2);
    const newApiRequest = observed.find(
      (value) => (value as { path?: string }).path === "/api/user/self",
    ) as { userId?: string; ua?: string };
    assert.equal(newApiRequest.userId, "123");
    assert.equal(newApiRequest.ua, "RelayDock-Atlas/1.0");
    passed.push(
      "explicit production queries travel through CONNECT proxy; usage and New API parse correctly",
    );
    inactive = true;
    const failed = await sync(fixtures[6].id);
    assert.equal(failed.status(), 502);
    const kept = (await list()).find((a) => a.id === fixtures[6].id)!;
    assert.equal(kept.balance, "28.5");
    assert.equal(kept.balanceUnit, "CNY");
    assert.equal(kept.lastSyncStatus, "error");
    assert.equal(queries, 3);
    assert.equal(connects, 3);
    passed.push(
      "inactive response rejected; last successful balance preserved, no retry",
    );
    await page.reload();
    await page.getByRole("button", { name: "列表视图" }).click();
    await page.locator(".site-row").first().waitFor();
    const row = page.locator(".site-row").filter({ hasText: "Usage 查询夹具" });
    await row.locator(".site-identity").click();
    await page.getByRole("button", { name: "编辑档案", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "解析预设" }).click();
    await page.getByRole("option", { name: /^通用 \/v1\/usage/ }).click();
    assert.equal(
      await dialog.locator('[name="queryPath"]').inputValue(),
      "/v1/usage",
    );
    await page.screenshot({
      path: join(out, "usage-preset-editor.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "保存站点", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      (await list()).find((a) => a.id === fixtures[6].id)?.query.extractionMode,
      "usage",
    );
    passed.push("editor exposes dropdown usage preset and saves without query");
    if (await page.getByRole("button", { name: "关闭账号详情" }).count())
      await page.getByRole("button", { name: "关闭账号详情" }).click();
    await page.getByRole("button", { name: "添加站点", exact: true }).click();
    const wizard = page.getByRole("dialog");
    await wizard
      .getByRole("radio", { name: "自定义余额接口", exact: true })
      .check();
    await wizard.getByRole("button", { name: "下一步", exact: true }).click();
    await wizard
      .getByLabel("站点名称", { exact: false })
      .fill("Usage 向导夹具");
    await wizard
      .getByLabel("网站地址", { exact: false })
      .fill(`http://127.0.0.1:${providerPort}`);
    await wizard.getByRole("combobox", { name: "解析预设" }).click();
    await page.getByRole("option", { name: /^通用 \/v1\/usage/ }).click();
    assert.equal(
      await wizard.getByLabel("GET 查询路径", { exact: false }).inputValue(),
      "/v1/usage",
    );
    assert.equal(
      await wizard.getByLabel("余额字段路径", { exact: false }).count(),
      0,
    );
    await wizard.getByRole("button", { name: "下一步", exact: true }).click();
    await wizard
      .getByRole("button", { name: "暂不测试，继续", exact: true })
      .click();
    await wizard.getByLabel("我已确认余额单位与查询口径").check();
    await wizard.getByRole("button", { name: "下一步", exact: true }).click();
    await wizard.getByLabel("我确认保存尚未验证的配置").check();
    await wizard.getByRole("button", { name: "保存站点", exact: true }).click();
    await wizard.waitFor({ state: "hidden" });
    const created = (await list()).find((a) => a.name === "Usage 向导夹具")!;
    assert.equal(created.query.extractionMode, "usage");
    assert.equal(created.query.path, "/v1/usage");
    assert.equal(created.balance, null);
    assert.equal(created.lastSyncStatus, "never");
    passed.push(
      "guided setup offers usage preset, saves unverified without fetching or fabricating a balance",
    );
    const touch = await browser.newContext({
      viewport: { width: 375, height: 900 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    await touch.addCookies(await context.cookies());
    const phone = await touch.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    phone.on("request", (req) => {
      if (req.url().endsWith("/accounts/move")) moves++;
    });
    await phone.goto(origin);
    await phone.locator(".site-row").first().waitFor();
    await phone.getByRole("button", { name: "地图视图" }).click();
    await phone.getByRole("button", { name: "显示全部站点" }).click();
    await phone.waitForTimeout(150);
    const touchPoint = async (id: string) => {
      const b = await phone
        .locator(`[data-account-id="${id}"] .node-core`)
        .boundingBox();
      assert.ok(b);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const touchFrom = await touchPoint(fixtures[5].id),
      touchTarget = await touchPoint(fixtures[2].id),
      cdp = await touch.newCDPSession(phone);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchFrom.x, y: touchFrom.y }],
    });
    for (let i = 1; i <= 12; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: touchFrom.x + ((touchTarget.x - touchFrom.x - 6) * i) / 12,
            y: touchFrom.y + ((touchTarget.y - touchFrom.y) * i) / 12,
          },
        ],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
    await phone.waitForFunction(
      async ({ origin, id }) =>
        (await (await fetch(origin + "/api/accounts")).json()).accounts.find(
          (a: { id: string; group: string }) => a.id === id,
        )?.group === "常用",
      { origin, id: fixtures[5].id },
    );
    assert.equal(
      await phone.getByTestId("atlas-map").getAttribute("data-dragging"),
      "false",
    );
    await phone.screenshot({
      path: join(out, "touch-drag-light-375.png"),
      fullPage: true,
    });
    await touch.close();
    passed.push(
      "touch defaults to list; reduced-motion phone map supports cross-group drag",
    );
    await page.reload();
    await page.locator("[data-account-id]").first().waitFor();
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await page
          .getByRole("button", { name: "切换到深色", exact: true })
          .click();
        await page.waitForFunction(
          () => document.documentElement.dataset.theme === "dark",
        );
      }
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("button", { name: "地图视图" }).click();
        await page.getByRole("button", { name: "显示全部站点" }).click();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page.screenshot({
          path: join(out, `map-${theme}-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page.waitForTimeout(500);
    assert.equal(queries, 3);
    assert.equal(connects, 3);
    assert.deepEqual(errors, []);
    passed.push("responsive map, navigation and idle remain query-free");
  } catch (error) {
    failure = error;
  } finally {
    if (failure && browser) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page) {
        await page.screenshot({ path: join(out, "failure.png") });
        writeFileSync(
          join(out, "failure-dom.txt"),
          await page.locator("body").innerText(),
        );
      }
    }
    await browser?.close();
    if (server && server.exitCode === null) {
      const exited = new Promise<void>((r) => server!.once("exit", () => r()));
      server.kill();
      await exited;
    }
    sockets.forEach((s) => s.destroy());
    await Promise.all(
      [provider, proxy].map(
        (s) => new Promise<void>((r) => s.close(() => r())),
      ),
    );
    assert.ok(
      resolve(temp).startsWith(resolve(tmpdir()) + sep) &&
        basename(temp).startsWith("atlas-drag-query-"),
    );
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
          buildId,
          isolated: true,
          passed,
          queries,
          connects,
          moves,
          observed,
          errors,
          failure: failure instanceof Error ? failure.message : null,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ out, passed, queries, connects, moves, errors }),
    );
  }
  if (failure) throw failure;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
