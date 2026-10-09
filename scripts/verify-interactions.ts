import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import assert from "node:assert/strict";
import { hashPassword } from "../src/lib/crypto";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

async function main() {
  const root = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), "atlas-interactions-"));
  const runtime = join(temp, "runtime");
  copyIsolatedBuild(root, runtime);
  const buildId = readFileSync(
    join(runtime, ".next", "BUILD_ID"),
    "utf8",
  ).trim();
  const out = join(root, "output", "playwright", "interactions");
  mkdirSync(out, { recursive: true });
  const origin =
    "http://127.0.0.1:" + (process.env.ATLAS_INTERACTION_PORT || "3318");
  const password = "isolated-interaction-password";
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(origin).port,
    ],
    {
      cwd: runtime,
      windowsHide: true,
      env: {
        ...cleanRuntimeEnv(),
        RELAYDOCK_DATA_DIR: temp,
        RELAYDOCK_ADMIN_PASSWORD_HASH: hashPassword(password),
        RELAYDOCK_PUBLIC_URL: "",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  server.stdout.on("data", (b) => (logs += String(b)));
  server.stderr.on("data", (b) => (logs += String(b)));
  const browser = await chromium.launch({
    headless: true,
    env: cleanRuntimeEnv() as Record<string, string>,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.addInitScript({
    content:
      "window.atlasCommits=0; window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject:function(){return 1;},onCommitFiberRoot:function(){window.atlasCommits++;},onCommitFiberUnmount:function(){}};window.atlasTransitionStarts=0; if(document.startViewTransition){const original=document.startViewTransition;document.startViewTransition=function(callback){window.atlasTransitionStarts++;return original.call(document,callback);};}",
  });
  page.setDefaultTimeout(3500);
  const errors: string[] = [],
    passed: string[] = [],
    failures: string[] = [];
  let zoomCommits: number | null = null,
    externalQueries = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/api\/.*\/(sync|test)$/.test(url.pathname)) externalQueries++;
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      errors.push("unexpected external browser request: " + url.hostname);
  });
  async function check(name: string, fn: () => Promise<void>) {
    if (
      process.env.ATLAS_INTERACTION_CHECK &&
      !name.includes(process.env.ATLAS_INTERACTION_CHECK)
    )
      return;
    try {
      await fn();
      passed.push(name);
      console.log("PASS " + name);
    } catch (e) {
      failures.push(name + ": " + (e as Error).message);
      console.log("FAIL " + failures.at(-1));
    }
  }
  async function idle() {
    await page.waitForFunction(
      () => document.documentElement.dataset.themeTransition !== "running",
    );
  }
  async function mapIdle() {
    await page.evaluate(() => {
      delete (window as unknown as { atlasMapStill?: unknown }).atlasMapStill;
    });
    await page.waitForFunction(() => {
      const element = document.querySelector(".atlas-svg > g");
      const transform = element?.getAttribute("transform");
      const host = window as unknown as {
        atlasMapStill?: { element: Element; transform: string; frames: number };
      };
      if (
        !element ||
        !transform ||
        document.querySelector(".atlas-map")?.getAttribute("data-panning") !==
          "false"
      ) {
        delete host.atlasMapStill;
        return false;
      }
      const previous = host.atlasMapStill;
      if (previous?.element === element && previous.transform === transform)
        previous.frames++;
      else host.atlasMapStill = { element, transform, frames: 0 };
      return (host.atlasMapStill?.frames || 0) >= 5;
    });
  }
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/api/auth/session")).ok) break;
      } catch {}
      if (i === 99) throw new Error("Preview did not start: " + logs);
      await new Promise((r) => setTimeout(r, 200));
    }
    await page.goto(origin);
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "进入我的群岛" }).click();
    await page.getByRole("button", { name: "添加第一个站点" }).waitFor();
    const session = await (
      await context.request.get(origin + "/api/auth/session")
    ).json();
    const api = async (path: string, method = "GET", data?: unknown) => {
      const response = await context.request.fetch(origin + "/api/" + path, {
        method,
        headers: { Origin: origin, "x-csrf-token": session.csrf },
        ...(data === undefined ? {} : { data }),
      });
      assert.ok(response.ok(), "fixture API request failed");
      return response.json();
    };
    for (const [name, group, balance] of [
      ["North API", "常用", "87.25"],
      ["Lumen Gate", "常用", "18.70"],
      ["Orbit Relay", "备用", "32.50"],
      ["Nova Lab", "实验", "0"],
    ]) {
      await api("accounts", "POST", {
        name,
        group,
        initialBalance: balance,
        siteUrl: "https://fixture.example",
        provider: "manual",
        unit: "USD",
      });
    }
    await page.reload();
    await page.locator("[data-node]").first().waitFor();

    await check("左键空白取消文字选区，同时保留可复制正文", async () => {
      await page.locator("h1").evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      assert.equal(
        await page.evaluate(() => window.getSelection()?.toString()),
        "站点群岛",
      );
      const box = await page.locator(".atlas-svg").boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + 12, box.y + box.height - 80);
      assert.equal(
        await page.evaluate(() => window.getSelection()?.toString()),
        "",
      );
    });
    await check("原创纸面菜单支持键盘选择与 Esc 返回焦点", async () => {
      const trigger = page.getByRole("combobox", {
        name: "筛选分组",
        exact: true,
      });
      assert.notEqual(
        await trigger.evaluate((el) => el.tagName),
        "SELECT",
        "group filter is still a native dropdown",
      );
      await trigger.focus();
      await page.keyboard.press("Space");
      await page.getByRole("listbox").waitFor();
      await page.getByRole("option", { name: "常用", exact: true }).click();
      assert.equal(
        await page.locator('[data-node][data-match="true"]').count(),
        2,
      );
      assert.equal(await page.locator("[data-node]").count(), 4);
      await trigger.click();
      await page.keyboard.press("Escape");
      assert.equal(
        await trigger.evaluate((el) => document.activeElement === el),
        true,
      );
      await trigger.click();
      await page.getByRole("option", { name: "所有分组", exact: true }).click();
      await trigger.click();
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== "running"),
      );
      await page.screenshot({ path: join(out, "select-light-desktop.png") });
      await page.keyboard.press("Escape");
    });
    await check("顶栏主题按钮：右上向左下揭幕并持久化", async () => {
      const toggle = page.getByRole("button", {
        name: "切换到深色",
        exact: true,
      });
      await toggle.waitFor();
      await toggle.click();
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "dark",
      );
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .some(
            (a) =>
              (a.effect as KeyframeEffect | null)?.pseudoElement ===
              "::view-transition-new(root)",
          ),
      );
      const frames = await page.evaluate(() => {
        const animation = document
          .getAnimations()
          .find(
            (a) =>
              (a.effect as KeyframeEffect | null)?.pseudoElement ===
              "::view-transition-new(root)",
          );
        return (animation?.effect as KeyframeEffect)
          ?.getKeyframes()
          .map((f) => f.clipPath);
      });
      assert.ok(
        String(frames?.[0]).includes("100% 0%"),
        "reveal must originate at upper right",
      );
      assert.ok(
        String(frames?.at(-1)).includes("0% 100%"),
        "reveal must reach lower left",
      );
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
          if (
            (animation.effect as KeyframeEffect | null)?.pseudoElement ===
            "::view-transition-new(root)"
          ) {
            animation.pause();
            animation.currentTime = 75;
          }
        }
      });
      await page.screenshot({ path: join(out, "theme-reveal.png") });
      await page.evaluate(() => {
        for (const animation of document.getAnimations())
          if (animation.playState === "paused") animation.play();
      });
      await idle();
      await page.waitForFunction(
        async () =>
          (await (await fetch("/api/auth/session")).json()).settings.theme ===
          "dark",
      );
      await page.reload();
      await page.locator("[data-node]").first().waitFor();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "dark",
      );
    });
    await check("主题保存失败回滚且显示真实错误", async () => {
      const previous = await page.locator("html").getAttribute("data-theme");
      await page.route("**/api/settings", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "测试：设置保存失败" }),
        }),
      );
      try {
        await page.locator(".theme-toggle").click();
        await page
          .getByRole("status")
          .filter({ hasText: "设置保存失败" })
          .waitFor();
        await page.waitForFunction(
          (value) => document.documentElement.dataset.theme === value,
          previous,
        );
        await idle();
      } finally {
        await page.unroute("**/api/settings");
      }
    });
    await check("快速重复切换只有一个设置写入，不发生竞态", async () => {
      let writes = 0;
      await page.route("**/api/settings", async (route) => {
        writes++;
        await new Promise((r) => setTimeout(r, 180));
        await route.continue();
      });
      try {
        await page.locator(".theme-toggle").evaluate((el) => {
          (el as HTMLButtonElement).click();
          (el as HTMLButtonElement).click();
        });
        await page.waitForFunction(
          () =>
            !(document.querySelector(".theme-toggle") as HTMLButtonElement)
              ?.disabled,
        );
        await idle();
        assert.equal(writes, 1);
      } finally {
        await page.unroute("**/api/settings");
      }
    });
    await check("设置页跟随系统与顶栏主题保持一致", async () => {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByLabel("跟随系统").check();
      await page.waitForFunction(
        async () =>
          (await (await fetch("/api/auth/session")).json()).settings.theme ===
          "system",
      );
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "dark",
      );
      await idle();
      assert.equal(
        await page
          .getByRole("button", { name: "切换到浅色", exact: true })
          .count(),
        1,
      );
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "light",
      );
      await idle();
      assert.equal(
        await page
          .getByRole("button", { name: "切换到深色", exact: true })
          .count(),
        1,
      );
      await page.getByRole("button", { name: "站点", exact: true }).click();
    });
    await check("旧账号读取不能覆盖刚保存的新主题", async () => {
      let release: (() => void) | undefined, captured: (() => void) | undefined, finished: (() => void) | undefined;
      const held = new Promise<void>((r) => (release = r)),
        fetched = new Promise<void>((r) => (captured = r)),
        handled = new Promise<void>((r) => (finished = r));
      await page.route("**/api/accounts", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        try {
          const response = await route.fetch();
          const body = await response.json();
          captured?.();
          await held;
          await route.fulfill({ response, json: body });
        } finally { finished?.(); }
      }, { times: 1 });
      try {
        // Initial reads intentionally show a skeleton; hold a later read instead.
        await page.locator("[data-node]").first().click();
        await page.getByRole("button", { name: "记录余额", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("余额 / USD").fill("31.23");
        await dialog.getByRole("button", { name: "保存记录", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await fetched;
        const previous = await page.locator("html").getAttribute("data-theme");
        const target = previous === "dark" ? "light" : "dark";
        await page.locator(".theme-toggle").click();
        await page.waitForFunction(
          async (value) =>
            (await (await fetch("/api/auth/session")).json()).settings.theme ===
            value,
          target,
        );
        await idle();
        release?.();
        await page.locator("[data-node]").first().waitFor();
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          target,
        );
      } finally {
        release?.();
        await handled;
        await page.unroute("**/api/accounts");
      }
    });
    await check(
      "详情有短时收起反馈，拖动节点不误选，轻微点击抖动仍可选中",
      async () => {
        await mapIdle();
        const node = page.locator(".node-core").first();
        let box = await node.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          box.x + box.width / 2 + 2,
          box.y + box.height / 2 + 1,
        );
        await page.mouse.up();
        await page.locator(".account-detail").waitFor();
        await page.getByRole("button", { name: "关闭账号详情" }).click();
        assert.equal(
          await page.locator(".account-detail").getAttribute("data-state"),
          "closing",
        );
        await page.locator(".account-detail").waitFor({ state: "hidden" });
        await mapIdle();
        box = await node.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          box.x + box.width / 2 + 30,
          box.y + box.height / 2 + 30,
          { steps: 12 },
        );
        await page.mouse.up();
        assert.equal(await page.locator(".account-detail").count(), 0);
      },
    );
    await check("地图连续平移、缩放、打断镜头不会误选或回跳", async () => {
      await page.getByRole("button", { name: "显示全部站点" }).click();
      await page.waitForTimeout(350);
      const map = await page.locator(".atlas-svg").boundingBox();
      assert.ok(map);
      const read = () =>
        page.locator(".atlas-svg > g").getAttribute("transform");
      const before = await read();
      await page.mouse.move(map.x + 12, map.y + map.height - 100);
      await page.mouse.down();
      await page.mouse.move(map.x + 92, map.y + map.height - 180, {
        steps: 18,
      });
      await page.mouse.up();
      assert.notEqual(await read(), before);
      assert.equal(await page.locator(".account-detail").count(), 0);
      const released = await read();
      await page.waitForTimeout(200);
      assert.equal(await read(), released);
      await page.getByRole("button", { name: "放大地图" }).click();
      await page.mouse.move(map.x + 12, map.y + map.height - 100);
      await page.mouse.down();
      await page.mouse.move(map.x + 62, map.y + map.height - 160, {
        steps: 12,
      });
      await page.mouse.up();
      const interrupted = await read();
      await page.waitForTimeout(350);
      assert.equal(await read(), interrupted);
      await page.getByRole("button", { name: "显示全部站点" }).click();
      await page.waitForTimeout(350);
    });
    await check("连续缩放不逐帧提交 React 节点树", async () => {
      const box = await page.locator(".atlas-svg").boundingBox();
      assert.ok(box);
      await page.waitForTimeout(600);
      const beforeZoom = await page
        .getByTestId("map-world")
        .getAttribute("transform");
      await page.evaluate(() => {
        (window as unknown as { atlasCommits: number }).atlasCommits = 0;
      });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -28);
      await page.waitForTimeout(250);
      const commits = await page.evaluate(
        () => (window as unknown as { atlasCommits: number }).atlasCommits,
      );
      zoomCommits = commits;
      assert.notEqual(
        await page.getByTestId("map-world").getAttribute("transform"),
        beforeZoom,
        "wheel input must move the camera",
      );
      assert.ok(
        // Unchanged LOD needs no React commit; retain the existing upper budget.
        commits >= 0 && commits <= 6,
        "twenty zoom events produced " + commits + " React commits",
      );
      await page.getByRole("button", { name: "显示全部站点" }).click();
      await page.waitForTimeout(350);
    });
    await check("拖动未松手时切页会释放全局手势和选区拦截", async () => {
      const box = await page.locator(".atlas-svg").boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + 12, box.y + box.height - 100);
      await page.mouse.down();
      try {
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="atlas-map"]')
              ?.getAttribute("data-panning") === "true",
        );
        await page.getByRole("button", { name: "设置", exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.getByRole("heading", { name: "让群岛适合你" }).waitFor();
        const handlers = await page.evaluate(() =>
          (
            (window as unknown as { __on?: { type: string; name: string }[] })
              .__on || []
          )
            .filter((entry) => entry.name === "zoom" || entry.name === "drag")
            .map((entry) => entry.type + "." + entry.name),
        );
        assert.deepEqual(handlers, []);
        await page.mouse.move(100, 120);
      } finally {
        await page.mouse.up();
      }
      await page.getByRole("button", { name: "站点", exact: true }).click();
    });
    await check("减少动效和关闭动效禁用揭幕，主题功能仍可用", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      let starts = await page.evaluate(
        () =>
          (window as unknown as { atlasTransitionStarts: number })
            .atlasTransitionStarts,
      );
      let before = await page.locator("html").getAttribute("data-theme");
      await page.locator(".theme-toggle").click();
      await idle();
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { atlasTransitionStarts: number })
              .atlasTransitionStarts,
        ),
        starts,
      );
      assert.notEqual(
        await page.locator("html").getAttribute("data-theme"),
        before,
      );
      // skipTransition releases Chromium's pseudo-elements asynchronously.
      // Check no new transitions above, then wait for native cleanup instead
      // of inspecting between the skip call and its next rendering frame.
      await page.waitForFunction(
        () =>
          document
            .getAnimations()
            .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement)
            .length === 0,
        undefined,
        { timeout: 1500 },
      );
      assert.equal(
        await page.evaluate(
          () =>
            document
              .getAnimations()
              .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement)
              .length,
        ),
        0,
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByLabel("装饰动效").uncheck();
      await page.waitForFunction(
        () => document.documentElement.dataset.motion === "false",
      );
      starts = await page.evaluate(
        () =>
          (window as unknown as { atlasTransitionStarts: number })
            .atlasTransitionStarts,
      );
      before = await page.locator("html").getAttribute("data-theme");
      await page.locator(".theme-toggle").click();
      await idle();
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { atlasTransitionStarts: number })
              .atlasTransitionStarts,
        ),
        starts,
      );
      assert.notEqual(
        await page.locator("html").getAttribute("data-theme"),
        before,
      );
      await page.waitForFunction(
        () =>
          document
            .getAnimations()
            .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement)
            .length === 0,
        undefined,
        { timeout: 1500 },
      );
      assert.equal(
        await page.evaluate(
          () =>
            document
              .getAnimations()
              .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement)
              .length,
        ),
        0,
      );
      await page.getByLabel("装饰动效").check();
      await page.getByRole("button", { name: "站点", exact: true }).click();
    });
    await check("滚轮与拖动重叠后切页也会释放全局监听", async () => {
      await page.getByRole("button", { name: "站点", exact: true }).click();
      await mapIdle();
      const box = await page.locator(".atlas-svg").boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + 12, box.y + box.height - 100);
      await page.mouse.wheel(0, -28);
      await page.mouse.down();
      try {
        await page.waitForTimeout(220); // Allow d3's earlier wheel idle event while the button stays down.
        assert.equal(
          await page.getByTestId("atlas-map").getAttribute("data-panning"),
          "true",
        );
        await page.getByRole("button", { name: "设置", exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.getByRole("heading", { name: "让群岛适合你" }).waitFor();
        const handlers = await page.evaluate(() =>
          (
            (window as unknown as { __on?: { type: string; name: string }[] })
              .__on || []
          )
            .filter((entry) => entry.name === "zoom" || entry.name === "drag")
            .map((entry) => entry.type + "." + entry.name),
        );
        assert.deepEqual(handlers, []);
      } finally {
        await page.mouse.up();
      }
      await page.getByRole("button", { name: "站点", exact: true }).click();
    });
    await check("不支持 View Transition 时直接切换，无浏览器异常", async () => {
      await page.evaluate(() => {
        (window as unknown as { savedTransition: unknown }).savedTransition =
          document.startViewTransition;
        Object.defineProperty(document, "startViewTransition", {
          configurable: true,
          value: undefined,
        });
      });
      const previous = await page.locator("html").getAttribute("data-theme");
      try {
        await page.locator(".theme-toggle").click();
        await page.waitForFunction(
          (v) => document.documentElement.dataset.theme !== v,
          previous,
        );
        await idle();
      } finally {
        await page.evaluate(() =>
          Object.defineProperty(document, "startViewTransition", {
            configurable: true,
            value: (window as unknown as { savedTransition: unknown })
              .savedTransition,
          }),
        );
      }
    });
    await check(
      "系统减少动效实时切换会真正停掉 Canvas，而非仅隐藏",
      async () => {
        const box = await page.locator(".atlas-map").boundingBox();
        assert.ok(box);
        await page.waitForFunction(
          () =>
            document
              .querySelector(".atlas-map")
              ?.getAttribute("data-panning") === "false",
        );
        try {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.mouse.move(box.x + 12, box.y + 12);
          await page.mouse.move(box.x + 65, box.y + 22);
          assert.equal(
            await page.locator("canvas").getAttribute("data-animating"),
            "false",
          );
        } finally {
          await page.emulateMedia({ reducedMotion: "no-preference" });
        }
      },
    );
    await check("375/768/1440 主题入口及菜单不溢出、不遮挡", async () => {
      await api("accounts", "POST", {
        name: "很长的站点名称也可以完整查看和定位",
        siteUrl: "https://fixture.example",
        provider: "manual",
        unit: "USD",
        group: "一个特别长的分组名称用来验证菜单文字可以换行而不是被截断",
      });
      await page.reload();
      await page.locator("[data-node]").first().waitFor();
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({
          width,
          height: width === 375 ? 812 : 960,
        });
        assert.equal(await page.locator(".theme-toggle").isVisible(), true);
        const select = page.getByRole("combobox", {
          name: "筛选分组",
          exact: true,
        });
        await select.click();
        const listbox = page.getByRole("listbox");
        await listbox.waitFor();
        const box = await listbox.boundingBox();
        assert.ok(box);
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.waitForFunction(() =>
          document.getAnimations().every((a) => a.playState !== "running"),
        );
        await page.screenshot({ path: join(out, "select-" + width + ".png") });
        await page.keyboard.press("Escape");
      }
      await page.setViewportSize({ width: 1440, height: 960 });
    });
    await check("触屏列表与纸面选择菜单可正常操作", async () => {
      const touch = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      });
      const phone = await touch.newPage();
      phone.on("pageerror", (e) => errors.push(e.message));
      try {
        await phone.goto(origin);
        await phone.locator(".site-row").first().waitFor();
        await phone
          .getByRole("combobox", { name: "筛选分组", exact: true })
          .tap();
        await phone.getByRole("option", { name: "常用", exact: true }).tap();
        assert.equal(await phone.locator(".site-row").count(), 2);
        assert.equal(
          await phone.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
      } finally {
        await touch.close();
      }
    });
    await check("装饰静置停止，操作动效不会启动外部查询", async () => {
      const box = await page.locator(".atlas-map").boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + 15, box.y + 15);
      await page.mouse.move(box.x + 80, box.y + 35);
      await page.waitForFunction(
        () =>
          document.querySelector("canvas")?.getAttribute("data-animating") ===
          "false",
        undefined,
        { timeout: 2000 },
      );
      await idle();
      await page.waitForFunction(
        () => document.getAnimations().every((a) => a.playState !== "running"),
        undefined,
        { timeout: 2000 },
      );
      assert.equal(externalQueries, 0);
      assert.equal(
        await page.evaluate(
          () =>
            document.getAnimations().filter((a) => a.playState === "running")
              .length,
        ),
        0,
      );
    });
    assert.deepEqual(errors, []);
    writeFileSync(
      join(out, "verification.json"),
      JSON.stringify(
        {
          passed,
          buildId,
          isolatedRuntimeWithoutEnvFiles: true,
          failures,
          errors,
          zoomCommits,
          zoomEvents: 20,
          externalQueries,
          isolatedDatabase: true,
        },
        null,
        2,
      ),
    );
    if (failures.length) throw new Error(failures.join("\n"));
  } finally {
    writeFileSync(join(out, "server-log.txt"), logs);
    await browser.close();
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once("exit", r));
      server.kill();
      await exited;
    }
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith("atlas-interactions-"));
    assert.equal(resolve(runtime), join(resolve(temp), "runtime"));
    unlinkSync(join(runtime, "node_modules"));
    rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
