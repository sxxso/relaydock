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
import { chromium, type Browser } from "playwright";
import { Store } from "../src/lib/store";
import { hashPassword } from "../src/lib/crypto";
import type { Account } from "../src/lib/validation";
import type { GroupLayout } from "../src/lib/group-layout";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

async function main() {
  const root = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "atlas-group-ui-")),
    runtime = join(temp, "runtime");
  const out = join(
    root,
    "output",
    "playwright",
    "group-layout",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(out, { recursive: true });
  const key = Buffer.alloc(32, 24),
    password = "isolated-group-layout-fixture",
    fixtures: Account[] = [];
  const passed: string[] = [],
    errors: string[] = [];
  let browser: Browser | undefined,
    server: ReturnType<typeof spawn> | undefined,
    failure: unknown,
    logs = "",
    moves = 0,
    queries = 0;
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const store = new Store(join(temp, "atlas.sqlite"), key);
    try {
      store.setMeta("adminHash", hashPassword(password));
      for (let i = 0; i < 8; i++)
        fixtures.push(
          store.create({
            name: `分组夹具 ${i}`,
            siteUrl: "https://fixture.invalid",
            group: i < 4 ? "常用" : i < 7 ? "备用" : "归档分组",
            archived: i === 7,
            initialBalance: "12.34",
          }),
        );
    } finally {
      store.close();
    }
    copyIsolatedBuild(root, runtime);
    const buildId = readFileSync(
      join(runtime, ".next", "BUILD_ID"),
      "utf8",
    ).trim();
    writeFileSync(join(out, "build-id.txt"), buildId);
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
      }),
      page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (req) => {
      if (new URL(req.url()).hostname !== "127.0.0.1")
        errors.push("external browser request");
      if (req.url().endsWith("map/groups/move")) moves++;
      if (/\/(sync|test)$/.test(req.url())) queries++;
    });
    await page.goto(origin);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "进入我的群岛" }).click();
    await page.locator("[data-group-handle]").first().waitFor();
    const state = async (): Promise<{
      accounts: Account[];
      groupLayout: GroupLayout;
    }> => await (await context.request.get(origin + "/api/accounts")).json();
    const initial = await state();
    const session = await (
      await context.request.get(origin + "/api/auth/session")
    ).json();
    const post = (
      name: string,
      position: { x: number; y: number } | null,
      expectedRevision: number,
    ) =>
      context.request.post(origin + "/api/map/groups/move", {
        headers: { origin, "x-csrf-token": session.csrf },
        data: { name, position, expectedRevision },
      });
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; ; i++) {
        if (await check()) return;
        assert.ok(i < 70, "condition did not settle");
        await page.waitForTimeout(60);
      }
    };
    const handle = (name: string) =>
      page.locator(`[data-group-handle="${name}"]`);
    const center = async (name: string) => {
      const b = await handle(name).locator("rect").boundingBox();
      assert.ok(b);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const start = async (name: string, dx = 80, dy = 65) => {
      const p = await center(name);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + dx, p.y + dy, { steps: 14 });
    };
    const world = () => page.getByTestId("map-world").getAttribute("transform");
    const nodePositions = () =>
      page.locator("[data-account-id]").evaluateAll((es) =>
        es.map((e) => ({
          id: e.getAttribute("data-account-id"),
          transform: e.getAttribute("transform"),
        })),
      );
    // Real guided flow: saved groups and archived names, no artificial account/query.
    await page.getByRole("button", { name: "添加站点", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByLabel(/^站点名称/).fill("菜单保存夹具");
    await dialog.getByLabel(/^网站地址/).fill("https://fixture.invalid");
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog
      .getByRole("button", { name: "继续确认单位", exact: true })
      .click();
    await dialog.getByLabel("我已确认余额单位与查询口径").check();
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByRole("combobox", { name: "分组", exact: true }).click();
    for (const name of ["常用", "备用", "归档分组", "未分组"])
      assert.equal(
        await page.getByRole("option", { name, exact: true }).count(),
        1,
      );
    await page.getByRole("option", { name: "备用", exact: true }).click();
    await page.screenshot({ path: join(out, "wizard-saved-group-light.png") });
    await dialog.getByRole("button", { name: "保存站点", exact: true }).click();
    await until(async () =>
      (await state()).accounts.some(
        (a) => a.name === "菜单保存夹具" && a.group === "备用",
      ),
    );
    passed.push(
      "guided add lists saved and archived groups; choice saves without provider queries",
    );
    // Existing editor shares the same menu and explicit new-group flow.
    await page.locator(`[data-account-id="${fixtures[0].id}"]`).click();
    await page.getByRole("button", { name: /编辑档案|编辑站点/ }).click();
    await dialog.getByRole("combobox", { name: "分组", exact: true }).click();
    await page.getByRole("option", { name: /^新建分组/ }).click();
    await dialog.getByLabel("新分组名称").fill("新分组");
    await dialog.getByRole("button", { name: "保存站点", exact: true }).click();
    await until(
      async () =>
        (await state()).accounts.find((a) => a.id === fixtures[0].id)?.group ===
        "新分组",
    );
    passed.push(
      "editor reuses refined menu, creates a group only when account saves",
    );
    await page.reload();
    await handle("常用").waitFor();
    await page
      .getByRole("button", { name: "显示全部站点", exact: true })
      .click();
    const camera = await world(),
      beforeNodes = await nodePositions(),
      beforeLayout = (await state()).groupLayout;
    await start("常用");
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-group-dragging")) === "常用",
    );
    assert.equal(await world(), camera, "group drag never pans camera");
    const heldNodes = await nodePositions();
    assert.notDeepEqual(
      heldNodes,
      beforeNodes,
      "nodes follow island while held",
    );
    assert.equal(moves, 0, "no write before release");
    await page.screenshot({ path: join(out, "group-held-light.png") });
    await page.mouse.up();
    await until(
      async () =>
        (await state()).groupLayout.revision === beforeLayout.revision + 1,
    );
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-move-pending")) === "false",
    );
    assert.equal(
      await world(),
      camera,
      "release does not jump or re-fit camera",
    );
    const saved = (await state()).groupLayout;
    assert.ok(saved.positions.some((p) => p.name === "常用"));
    for (const original of initial.accounts) {
      const a = (await state()).accounts.find((x) => x.id === original.id)!;
      assert.equal(a.balance, original.balance);
      assert.equal(a.balanceSnapshotId, original.balanceSnapshotId);
      assert.equal(a.mapOrder, original.mapOrder);
    }
    passed.push(
      "held group follows pointer; release persists with unchanged camera, balances, history and site order",
    );
    await page.reload();
    await handle("常用").waitFor();
    assert.deepEqual((await state()).groupLayout, saved);
    const islandOrigin = await page
      .locator('[data-island-group="常用"]')
      .locator("ellipse")
      .getAttribute("cx");
    assert.ok(Number(islandOrigin) > 0);
    passed.push(
      "reload retains explicit island position and performs initial fit",
    );
    const beforeCancel = moves,
      unchanged = (await state()).groupLayout;
    await start("常用", 55, 30);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    await page.mouse.up();
    assert.equal(moves, beforeCancel);
    assert.deepEqual((await state()).groupLayout, unchanged);
    assert.equal(
      await page
        .locator('[data-island-group="常用"]')
        .getAttribute("transform"),
      null,
    );
    passed.push(
      "Escape cancels held group without write, stale transform or accidental detail",
    );
    await page.route("**/api/map/groups/move", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "夹具保存失败" }),
      }),
    );
    const failureNodes = await nodePositions();
    await start("常用", 40, 40);
    await page.mouse.up();
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-move-pending")) === "false",
    );
    assert.deepEqual((await state()).groupLayout, unchanged);
    assert.deepEqual(await nodePositions(), failureNodes);
    await page.unroute("**/api/map/groups/move");
    passed.push(
      "failed persistence rolls back whole group without balance writes",
    );
    // Keyboard micro-adjustment, collapsed islands and reset all hit real API.
    await page
      .getByRole("button", { name: "折叠分组 常用", exact: true })
      .click();
    await handle("常用").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await until(
      async () =>
        (await state()).groupLayout.revision === unchanged.revision + 1,
    );
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-move-pending")) === "false",
    );
    assert.equal(
      (await state()).groupLayout.positions.find((p) => p.name === "常用")!.x,
      unchanged.positions.find((p) => p.name === "常用")!.x + 100,
    );
    await handle("常用").focus();
    await page.keyboard.press("Home");
    await until(
      async () =>
        !(await state()).groupLayout.positions.some((p) => p.name === "常用"),
    );
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-move-pending")) === "false",
    );
    await page
      .getByRole("button", { name: "展开分组 常用", exact: true })
      .and(page.locator(".island-header-action"))
      .click();
    passed.push(
      "collapsed group keyboard movement works; Home resets only its placement",
    );
    const svgBox = await page.locator(".atlas-svg").boundingBox();
    assert.ok(svgBox);
    const blank = await page.evaluate(() => {
      const r = document.querySelector(".atlas-svg")!.getBoundingClientRect();
      for (let y = 0.25; y < 0.8; y += 0.12)
        for (let x = 0.05; x < 0.95; x += 0.12) {
          const px = r.x + r.width * x,
            py = r.y + r.height * y,
            e = document.elementFromPoint(px, py);
          if (
            e?.closest(".atlas-svg") &&
            !e.closest("[data-node],[data-map-control],button")
          )
            return { x: px, y: py };
        }
      return null;
    });
    assert.ok(blank);
    const beforePan = await world(),
      writesBeforePan = moves;
    await page.mouse.move(blank.x, blank.y);
    await page.mouse.down();
    await page.mouse.move(blank.x + 65, blank.y + 25, { steps: 12 });
    await page.mouse.up();
    await until(async () => (await world()) !== beforePan);
    assert.equal(moves, writesBeforePan);
    await handle("常用").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "放大地图", exact: true }).click();
    const k = await page
      .getByTestId("map-world")
      .evaluate((e) => (e as SVGGraphicsElement).getScreenCTM()!.a);
    const revisionBeforeZoomDrag = (await state()).groupLayout.revision,
      headerBefore = await center("常用");
    await start("常用", 40, 35);
    await page.mouse.up();
    await until(
      async () =>
        (await state()).groupLayout.revision === revisionBeforeZoomDrag + 1,
    );
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-move-pending")) === "false",
    );
    const headerAfter = await center("常用");
    assert.ok(
      Math.abs(headerAfter.x - headerBefore.x - 40) < 0.3 && k > 0,
      "zoom/pan projected drag follows screen pointer",
    );
    passed.push(
      "blank drag stays pan; group drag after zoom/pan uses exact world projection",
    );
    // A second client changes the layout; stale gesture is rejected and reloaded.
    const stale = (await state()).groupLayout;
    const conflict = await post("备用", { x: 1100, y: 680 }, stale.revision);
    assert.equal(conflict.status(), 200);
    const winner = (await conflict.json()) as GroupLayout;
    await start("常用", 25, 25);
    await page.mouse.up();
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-move-pending")) === "false",
    );
    assert.deepEqual((await state()).groupLayout, winner);
    await page.reload();
    await handle("常用").waitFor();
    passed.push(
      "stale client layout rejected atomically and canonical layout retained",
    );
    // A release outside the actual SVG viewport must cancel.
    const outsideBefore = moves;
    await start("常用", 20, 20);
    const outside = await page.locator(".atlas-svg").boundingBox();
    assert.ok(outside);
    await page.mouse.move(outside.x + outside.width / 2, outside.y - 18);
    await page.mouse.up();
    assert.equal(moves, outsideBefore);
    assert.deepEqual((await state()).groupLayout, winner);
    passed.push(
      "captured pointer release outside viewport cancels without writes",
    );
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        await page.screenshot({
          path: join(out, `map-${theme}-${width}.png`),
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
      }
    }
    const phoneContext = await browser.newContext({
      viewport: { width: 375, height: 860 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    await phoneContext.addCookies(await context.cookies());
    const phone = await phoneContext.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(origin);
    await phone.getByTestId("site-list").waitFor();
    await phone.getByRole("button", { name: "地图视图", exact: true }).click();
    const phoneHandle = phone.locator('[data-group-handle="常用"]');
    await phoneHandle.waitFor();
    await phone.waitForFunction(() => {
      const map = document.querySelector(".atlas-map")!,
        svg = map.querySelector(".atlas-svg")!;
      return (
        Math.abs(
          // ResizeObserver supplies content width, not the printed border box.
          Number(svg.getAttribute("width")) - map.clientWidth,
        ) < 1
      );
    });
    await phoneHandle.focus();
    await phone.keyboard.press("Enter");
    await phone.waitForFunction(
      () =>
        (
          document.querySelector(
            '[data-testid="map-world"]',
          ) as SVGGraphicsElement
        ).getScreenCTM()!.a > 0.6,
    );
    const touchCamera = await phone
      .getByTestId("map-world")
      .getAttribute("transform");
    const touchRevision = (await state()).groupLayout.revision;
    // Use actual CDP touch events (pointer capture must originate from a real pointer).
    const cdp = await phoneContext.newCDPSession(phone),
      box = await phoneHandle.locator("rect").boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + 25, y: y + 24 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await until(
      async () => (await state()).groupLayout.revision === touchRevision + 1,
    );
    await phone.waitForFunction(
      () =>
        document
          .querySelector(".atlas-map")
          ?.getAttribute("data-move-pending") === "false",
    );
    assert.equal(
      await phone.getByTestId("map-world").getAttribute("transform"),
      touchCamera,
      "touch release retains focused camera",
    );
    await phone.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await phone.screenshot({
      path: join(out, "touch-group-dark-375.png"),
      fullPage: true,
    });
    passed.push(
      "375/768/1440 light/dark readable without overflow; actual touch drag works with reduced motion and list default",
    );
    // Exercise the new whole-island gesture with 500 additional real fixture rows.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const large = new Store(join(temp, "atlas.sqlite"), key);
    try {
      for (let i = 0; i < 500; i++)
        large.create({
          name: `大组夹具 ${i}`,
          group: "常用",
          siteUrl: "https://fixture.invalid",
        });
    } finally {
      large.close();
    }
    await page.reload();
    await handle("常用").waitFor();
    await until(
      async () => (await page.locator("[data-account-id]").count()) === 508,
    );
    await page.evaluate(() => {
      const counters = { mounts: 0 };
      Object.assign(window, { groupCounters: counters });
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of [...record.addedNodes, ...record.removedNodes])
            if (node instanceof Element && node.matches("[data-account-id]"))
              counters.mounts++;
      }).observe(document.querySelector('[data-testid="map-world"]')!, {
        childList: true,
        subtree: true,
      });
    });
    const largeRevision = (await state()).groupLayout.revision,
      largeBefore = await nodePositions();
    await start("常用", 25, 25);
    await until(
      async () =>
        (await page
          .locator('[data-island-group="常用"]')
          .getAttribute("transform")) !== null,
    );
    const largeHeld = await nodePositions();
    const ids = new Set(
      (await state()).accounts
        .filter((a) => a.group === "常用")
        .map((a) => a.id),
    );
    for (const n of largeBefore) {
      const next = largeHeld.find((x) => x.id === n.id)!;
      if (ids.has(n.id!)) assert.notEqual(next.transform, n.transform);
      else assert.equal(next.transform, n.transform);
    }
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { groupCounters: { mounts: number } })
            .groupCounters.mounts,
      ),
      0,
    );
    await page.mouse.up();
    await until(
      async () => (await state()).groupLayout.revision === largeRevision + 1,
    );
    await until(
      async () =>
        (await page
          .getByTestId("atlas-map")
          .getAttribute("data-move-pending")) === "false",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({
      path: join(out, "large-group-500-dark.png"),
      fullPage: true,
    });
    passed.push(
      "503-site island follows as one gesture; unrelated nodes stay fixed and no node mount/unmount occurs while dragging (not an FPS guarantee)",
    );
    await page.waitForTimeout(500);
    assert.equal(queries, 0);
    assert.deepEqual(errors, []);
    passed.push("all navigation, group menus and gestures remain query-free");
  } catch (e) {
    failure = e;
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
    assert.ok(
      resolve(temp).startsWith(resolve(tmpdir()) + sep) &&
        basename(temp).startsWith("atlas-group-ui-"),
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
          isolated: true,
          passed,
          moves,
          queries,
          errors,
          failure: failure instanceof Error ? failure.message : null,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ out, passed, moves, queries, errors }));
  }
  if (failure) throw failure;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
