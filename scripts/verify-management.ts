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
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { chromium, type Page, type Browser } from "playwright";
import { Store } from "../src/lib/store";
import { hashPassword } from "../src/lib/crypto";
import type { Account } from "../src/lib/validation";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

// A production build copy and synthetic data only. No actual environment/data is read.
async function main() {
  const root = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "atlas-management-ui-")),
    runtime = join(temp, "runtime");
  const out = join(
    root,
    "output",
    "playwright",
    "management",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(out, { recursive: true });
  const port = 3323,
    origin = `http://127.0.0.1:${port}`,
    key = Buffer.alloc(32, 6),
    password = "fixture-management-password-123";
  const redOnly = process.argv.includes("--red-only");
  const passed: string[] = [],
    errors: string[] = [],
    cleanupErrors: string[] = [],
    screenshots: string[] = [];
  const metrics: {
    accounts: number;
    zoomEvents: number;
    reactCommits: number;
    idleRafCalls: number;
  }[] = [];
  const zoomTimelines: {
    accounts: number;
    wheels: number[];
    commits: { at: number; panning: string | null }[];
  }[] = [];
  let page: Page | undefined,
    browser: Browser | undefined,
    server: ReturnType<typeof spawn> | undefined;
  let logs = "",
    failure: unknown,
    externalQueries = 0,
    buildId = "",
    csrf = "";
  const fixtures: Account[] = [];
  function seed(total: number) {
    const store = new Store(join(temp, "atlas.sqlite"), key);
    try {
      if (!fixtures.length) {
        store.setMeta("adminHash", hashPassword(password));
        fixtures.push(
          store.create({
            name: "松岛 Alpha",
            alias: "工作",
            siteUrl: "https://alpha.fixture.invalid",
            group: "常用",
            provider: "custom",
            credential: "FIXTURE_ONLY_NEVER_QUERY",
            initialBalance: "13.37",
            favorite: true,
            tags: ["常用"],
          }),
        );
        fixtures.push(
          store.create({
            name: "墨湾 Beta",
            alias: "备用",
            siteUrl: "https://beta.fixture.invalid",
            group: "常用",
            initialBalance: "40",
            tags: ["常用", "工作"],
          }),
        );
        fixtures.push(
          store.create({
            name: "青岬 Gamma",
            alias: "CNY",
            siteUrl: "https://gamma.fixture.invalid",
            group: "备用",
            unit: "CNY",
            initialBalance: "8",
            favorite: true,
            tags: ["工作"],
          }),
        );
        fixtures.push(
          store.create({
            name: "手记 Unknown 很长的站点名称用于检查布局与完整可访问名称",
            alias: "未知",
            siteUrl: "https://unknown.fixture.invalid",
            group: "手记",
          }),
        );
      }
      for (let i = fixtures.length; i < total; i++)
        fixtures.push(
          store.create({
            name: `夹具站点 ${String(i).padStart(3, "0")}`,
            alias: `账号 ${i}`,
            siteUrl: "https://bulk.fixture.invalid",
            group: `群岛 ${i % 8}`,
            initialBalance: i % 3 ? String(i) : null,
            favorite: i % 7 === 0,
          }),
        );
    } finally {
      store.close();
    }
  }
  async function stopServer() {
    const child = server;
    if (!child || child.exitCode !== null) return;
    const ended = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill();
    await ended;
    server = undefined;
  }
  async function startServer() {
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
          RELAYDOCK_ADMIN_PASSWORD_HASH: hashPassword(password),
          RELAYDOCK_PUBLIC_URL: origin,
          RELAYDOCK_DNS_MODE: "system",
          RELAYDOCK_PRIVATE_HOSTS: "",
        },
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
        if ((await fetch(origin + "/api/auth/session")).ok) return;
      } catch {}
      assert.ok(
        i < 99 && server.exitCode === null,
        "isolated server failed to start",
      );
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    await new Promise<void>((done, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => done()));
    });
    seed(4);
    copyIsolatedBuild(root, runtime);
    buildId = readFileSync(join(runtime, ".next", "BUILD_ID"), "utf8").trim();
    await startServer();
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(6000);
    await context.addInitScript({
      content: `window.atlasCommits=0;window.atlasPerf={wheels:[],commits:[]};document.addEventListener('wheel',function(e){if(e.target.closest?.('.atlas-svg'))window.atlasPerf.wheels.push(performance.now());},true);window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject:function(){return 1;},onCommitFiberRoot:function(){window.atlasCommits++;window.atlasPerf.commits.push({at:performance.now(),panning:document.querySelector('[data-testid="atlas-map"]')?.getAttribute('data-panning')??null});},onCommitFiberUnmount:function(){}};window.atlasRafCalls=0;window.atlasRafs=new Set();const oldRaf=window.requestAnimationFrame.bind(window),oldCancel=window.cancelAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){window.atlasRafCalls++;const id=oldRaf(function(t){window.atlasRafs.delete(id);cb(t);});window.atlasRafs.add(id);return id;};window.cancelAnimationFrame=function(id){window.atlasRafs.delete(id);oldCancel(id);};`,
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (
        /\/api\/(?:accounts\/[^/]+\/(?:sync|test)|query\/test)$/.test(
          url.pathname,
        )
      )
        externalQueries++;
      if (url.origin !== origin && ["http:", "https:"].includes(url.protocol))
        errors.push("unexpected browser network request");
    });
    const p = page;
    async function api(path: string, method = "GET", data?: unknown) {
      return p.request.fetch(origin + "/api/" + path, {
        method,
        headers: { origin, "x-csrf-token": csrf },
        ...(data === undefined ? {} : { data }),
      });
    }
    async function list(): Promise<Account[]> {
      const response = await api("accounts");
      assert.equal(response.status(), 200);
      return (await response.json()).accounts;
    }
    const positions = () =>
      p.evaluate(
        `Object.fromEntries([...document.querySelectorAll('[data-node]')].map(n=>[n.getAttribute('data-account-id'),n.getAttribute('transform')]))`,
      ) as Promise<Record<string, string>>;
    const camera = () => p.getByTestId("map-world").getAttribute("transform");
    async function settled() {
      await p.waitForFunction(
        `() => document.querySelector('[data-testid="map-world"]')?.getAttribute('transform') != null`,
      );
      await p.waitForTimeout(500);
    }
    async function choose(label: string, name: string) {
      if (
        label === "档案范围" &&
        !(await p
          .locator(".filter-menu")
          .evaluate((el) => (el as HTMLDetailsElement).open))
      )
        await p.locator(".filter-menu > summary").click();
      await p.getByRole("combobox", { name: label, exact: true }).click();
      await p.getByRole("option", { name: new RegExp("^" + name) }).click();
    }
    async function shot(name: string, fullPage = true) {
      await p.screenshot({
        path: join(out, name),
        fullPage,
        animations: "disabled",
      });
      screenshots.push(name);
    }
    async function closeDetail() {
      const close = p.getByRole("button", { name: "关闭账号详情" });
      if (await close.count()) {
        await close.click();
        await p.waitForTimeout(300);
      }
    }
    await p.goto(origin);
    await p.getByLabel("管理员密码").fill(password);
    await p.getByRole("button", { name: "进入我的群岛" }).click();
    await p.getByTestId("atlas-map").waitFor();
    await settled();
    csrf = (await (await api("auth/session")).json()).csrf;
    assert.equal(await p.getByTestId("map-world").count(), 1); // intentional old-build RED gate
    if (redOnly)
      throw new Error(
        "old build unexpectedly has stage-four map-world; RED requires the previous build",
      );
    const initial = await positions(),
      initialCamera = await camera();
    assert.equal(Object.keys(initial).length, 4);
    await p.getByLabel("搜索站点").fill("Alpha");
    await p.waitForTimeout(150);
    assert.equal(await p.locator('[data-node][data-match="true"]').count(), 1);
    assert.equal(await p.locator(".map-node.is-dimmed").count(), 3);
    assert.deepEqual(await positions(), initial);
    assert.equal(await camera(), initialCamera);
    await p.getByLabel("搜索站点").fill("没有匹配");
    assert.equal(await p.getByTestId("atlas-map").count(), 1);
    await p.getByText("没有匹配的账号", { exact: true }).waitFor();
    assert.deepEqual(await positions(), initial);
    await p.getByLabel("搜索站点").fill("");
    passed.push("搜索/无匹配保留全量坐标与镜头，淡化而非重排");

    await p.getByRole("button", { name: "只看收藏" }).click();
    await p.getByRole("button", { name: "列表视图" }).click();
    assert.equal(await p.locator(".site-row").count(), 2);
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    assert.equal(await p.locator('[data-node][data-match="true"]').count(), 2);
    assert.deepEqual(await positions(), initial);
    await p.getByRole("button", { name: "只看收藏" }).click();
    await choose("筛选币种", "CNY");
    assert.equal(await p.locator('[data-node][data-match="true"]').count(), 1);
    await p.getByRole("button", { name: "列表视图" }).click();
    assert.equal(await p.locator(".site-row").count(), 1);
    await choose("筛选币种", "所有单位");
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    passed.push("地图/列表共享收藏与单位范围，坐标一致");
    await choose("筛选分组", "常用");
    await p.getByRole("button", { name: "只看收藏" }).click();
    await p.getByRole("button", { name: "保存当前视图" }).click();
    const viewNameInput = p.locator("input[aria-label=\"视图名称\"]");
    await viewNameInput.fill("常用收藏");
    assert.equal(await viewNameInput.inputValue(), "常用收藏");
    const saveViewButton = p.getByRole("button", { name: "保存视图", exact: true });
    assert.equal(await saveViewButton.isDisabled(), false);
    const saveViewResponse = p.waitForResponse((response) => response.url().endsWith("/api/views") && response.request().method() === "PUT");
    await saveViewButton.click();
    assert.equal((await saveViewResponse).status(), 200);
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await p.getByRole("combobox", { name: "已保存视图", exact: true }).count(), 1);
    await p.getByRole("button", { name: "列表视图" }).click();
    assert.equal(await p.locator(".site-row").count(), 1);
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    assert.equal(await p.locator('[data-node][data-match="true"]').count(), 1);
    const savedViewsResponse = await api("accounts");
    assert.equal(savedViewsResponse.status(), 200);
    const savedViewsBody = await savedViewsResponse.json();
    assert.equal(savedViewsBody.savedViews.length, 1);
    assert.equal(savedViewsBody.savedViews[0].name, "常用收藏");
    await choose("筛选分组", "所有分组");
    await p.getByRole("button", { name: "只看收藏" }).click();
    await p.reload();
    await p.getByTestId("atlas-map").waitFor();
    await settled();
    await choose("已保存视图", "常用收藏");
    await p.getByRole("button", { name: "列表视图" }).click();
    assert.equal(await p.locator(".site-row").count(), 1);
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    assert.equal(externalQueries, 0);
    passed.push("保存视图可刷新后切换，地图/列表共用筛选且只读本地数据");
    await choose("筛选分组", "所有分组");
    await p.getByRole("button", { name: "只看收藏" }).click();

    await p.locator(".map-group-index > summary").click();
    await p
      .locator(".map-group-index")
      .getByRole("button", { name: "折叠分组 常用", exact: true })
      .click();
    assert.equal(await p.locator("[data-node]").count(), 2);
    await p.getByLabel("搜索站点").fill("Alpha");
    await p.getByRole("button", { name: "定位匹配站点" }).click();
    await p.getByRole("complementary", { name: "当前账号详情" }).waitFor();
    await settled();
    assert.deepEqual(await positions(), initial);
    assert.equal(
      await p
        .locator(`[data-account-id="${fixtures[0].id}"]`)
        .getAttribute("aria-pressed"),
      "true",
    );
    const beforeRecordCamera = await camera();
    await p.getByRole("button", { name: "记录余额", exact: true }).click();
    await p.getByLabel("余额 / USD", { exact: true }).fill("14.25");
    await p.getByRole("button", { name: "保存记录", exact: true }).click();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    await p.waitForFunction(
      `() => document.querySelector('.detail-balance')?.textContent.includes('14.25')`,
    );
    assert.deepEqual(await positions(), initial);
    assert.equal(await camera(), beforeRecordCamera);
    await closeDetail();
    await p.getByLabel("搜索站点").fill("");
    passed.push("折叠保留岛位，定位自动展开；真实手动记录不移动节点/镜头");

    const mapIndex = p.locator(".map-group-index");
    await mapIndex
      .getByRole("button", { name: "折叠分组 常用", exact: true })
      .click();
    await p.getByRole("button", { name: "列表视图" }).click();
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    assert.equal(await p.locator("[data-node]").count(), 2);
    await p.locator(".map-group-index > summary").click();
    await p
      .locator(".map-group-index")
      .getByRole("button", { name: "展开分组 常用", exact: true })
      .click();
    assert.deepEqual(await positions(), initial);
    const beforeGroupFocus = await camera();
    await p
      .locator(".map-group-index")
      .getByRole("button", { name: "聚焦分组 手记", exact: true })
      .click();
    await p.waitForTimeout(400);
    assert.notEqual(await camera(), beforeGroupFocus);
    await p.locator(".map-group-index > summary").click();
    passed.push("折叠跨视图保留/展开还原，分组聚焦真实改变镜头");

    const mini = p.getByRole("group", { name: "地图定位小窗", exact: true });
    await mini.focus();
    const beforeKey = await camera();
    await mini.press("ArrowRight");
    await p.waitForTimeout(100);
    assert.notEqual(await camera(), beforeKey);
    await mini.press("Home");
    await p.waitForTimeout(400);
    const beforeMini = await camera();
    const miniBox = await mini.boundingBox();
    assert.ok(miniBox);
    const islandBox = await mini
      .getByRole("button", { name: "定位分组 常用", exact: true })
      .boundingBox();
    assert.ok(islandBox);
    await p.mouse.move(
      islandBox.x + islandBox.width / 2,
      islandBox.y + islandBox.height / 2,
    );
    await p.mouse.down();
    await p.mouse.move(
      miniBox.x + miniBox.width - 8,
      miniBox.y + miniBox.height - 10,
      { steps: 10 },
    );
    await p.waitForTimeout(100);
    const islandDragCamera = await camera();
    assert.notEqual(
      islandDragCamera,
      beforeMini,
      "drag starting inside an island must move the camera",
    );
    await p.mouse.up();
    await p.waitForTimeout(400);
    assert.equal(
      await camera(),
      islandDragCamera,
      "island drag must not turn into group click on release",
    );
    await p.mouse.move(miniBox.x + 5, miniBox.y + 8);
    await p.mouse.down();
    await p.mouse.move(
      miniBox.x + miniBox.width - 5,
      miniBox.y + miniBox.height - 8,
      { steps: 8 },
    );
    await p.mouse.up();
    await p.waitForTimeout(100);
    assert.notEqual(await camera(), beforeMini);
    await mini
      .getByRole("button", { name: "定位分组 常用", exact: true })
      .focus();
    await mini
      .getByRole("button", { name: "定位分组 常用", exact: true })
      .press("Enter");
    await p.waitForTimeout(400);
    assert.ok(
      Number(await p.getByTestId("minimap-viewport").getAttribute("width")) > 0,
    );
    await p.getByRole("button", { name: "定位小窗", exact: true }).click();
    assert.equal(await p.getByTestId("map-minimap").count(), 0);
    await p.getByRole("button", { name: "定位小窗", exact: true }).click();
    await p.getByTestId("map-minimap").waitFor();
    passed.push("定位小窗拖动、方向键/Home、分组键盘定位、开关与视口同步");

    for (const kind of ["点阵", "方格", "十字坐标", "等高线"]) {
      await choose("地图背景", kind);
      await p.getByRole("button", { name: "显示全部站点" }).click();
      await p.waitForTimeout(400);
      for (const button of ["缩小地图", "缩小地图", "放大地图", "放大地图"]) {
        await p.getByRole("button", { name: button }).click();
        await p.waitForTimeout(230);
        const spacing = Number(
          await p.getByTestId("atlas-map").getAttribute("data-grid-spacing"),
        );
        const minimumSpacing = kind === "等高线" ? 32 : 24;
        assert.ok(spacing >= minimumSpacing && spacing <= minimumSpacing * 2 + 0.01,
          `${kind} must retain its adaptive spacing range; measured ${spacing}px`);
      }
    }
    passed.push("点阵/方格/十字维持 24–48px、等高线维持 32–64px 采样间距");

    await p.getByRole("button", { name: "列表视图" }).click();
    await p.getByRole("button", { name: "批量管理", exact: true }).click();
    const checkbox = (a: Account) =>
      p.getByRole("checkbox", {
        name: `选择 ${a.name} ${a.alias}`.trim(),
        exact: true,
      });
    await p.getByRole("button", { name: "只看收藏" }).click();
    await checkbox(fixtures[0]).check();
    await checkbox(fixtures[2]).check();
    await p
      .locator(".site-row")
      .filter({ has: checkbox(fixtures[0]) })
      .locator(".site-identity")
      .click();
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (ready = r));
    const favoriteUrl =
      origin + "/api/accounts/" + fixtures[0].id + "/favorite";
    await p.route(favoriteUrl, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      ready();
      await held;
      await route.fulfill({ response });
    });
    try {
      await p.getByRole("button", { name: "取消收藏", exact: true }).click();
      await Promise.race([
        started,
        p.waitForTimeout(6000).then(() => {
          throw new Error("favorite fixture response was not intercepted");
        }),
      ]);
      await closeDetail();
      await p.getByRole("button", { name: "编辑标签", exact: true }).click();
      await p.getByLabel("标签（逗号分隔）").fill("范围确认夹具");
      release();
      await p.getByText("已选 1 个", { exact: true }).waitFor();
      assert.equal(
        await p
          .getByRole("button", { name: "应用标签", exact: true })
          .isDisabled(),
        true,
        "stale modal scope must not submit old A/B targets",
      );
      const unchanged = await list();
      await p
        .locator(".batch-form")
        .evaluate((el) => (el as HTMLFormElement).requestSubmit());
      await p.waitForTimeout(180);
      assert.deepEqual(await list(), unchanged);
      await p
        .getByRole("alert")
        .filter({ hasText: "操作范围已变化" })
        .waitFor();
      await p.setViewportSize({ width: 375, height: 1000 });
      await shot("batch-scope-changed-375.png", false);
      await p.setViewportSize({ width: 1440, height: 1000 });
      await p
        .getByRole("button", { name: "重新确认当前范围", exact: true })
        .click();
      await p.getByRole("button", { name: "应用标签", exact: true }).click();
      await p.getByRole("dialog").waitFor({ state: "hidden" });
      const changed = await list();
      assert.deepEqual(
        changed.find((a) => a.id === fixtures[0].id)!.tags,
        fixtures[0].tags,
      );
      assert.ok(
        changed
          .find((a) => a.id === fixtures[2].id)!
          .tags.includes("范围确认夹具"),
      );
    } finally {
      release();
      await p.unroute(favoriteUrl);
    }
    await api("accounts/batch", "POST", {
      ids: [fixtures[2].id],
      operation: { kind: "tags", mode: "remove", tags: ["范围确认夹具"] },
    });
    await p.getByRole("button", { name: "只看收藏" }).click();
    await p
      .locator(".site-row")
      .filter({ has: checkbox(fixtures[0]) })
      .locator(".site-identity")
      .click();
    await p.getByRole("button", { name: "收藏账号", exact: true }).click();
     await p.getByRole("button", { name: "撤销", exact: true }).waitFor({ timeout: 6000 });
     await p.getByRole("button", { name: "撤销", exact: true }).click();
     assert.equal((await list()).find((a) => a.id === fixtures[0].id)!.favorite, false);
     passed.push("收藏完成后显示短时撤销入口，撤销只恢复收藏字段");
     await p.getByRole("button", { name: "收藏账号", exact: true }).click();
    await p.waitForFunction(
      `() => document.querySelector('.account-detail button[aria-label="取消收藏"]') != null`,
    );
    await closeDetail();
    await p.reload();
    await p.getByTestId("atlas-map").waitFor();
    await p.getByRole("button", { name: "列表视图" }).click();
    await p.getByRole("button", { name: "批量管理", exact: true }).click();
    passed.push(
      "异步档案变化使弹窗范围失效；阻止旧范围提交，重新确认只操作当前账号",
    );
    await checkbox(fixtures[0]).check();
    await checkbox(fixtures[1]).check();
    await p.getByText("已选 2 个", { exact: true }).waitFor();
    await p.getByLabel("搜索站点").fill("Alpha");
    await p.getByText("已选 1 个", { exact: true }).waitFor();
    await p.getByLabel("搜索站点").fill("");
    await p.getByText("已选 1 个", { exact: true }).waitFor();
    await p.getByRole("button", { name: "地图视图" }).click();
    await p.getByRole("button", { name: "列表视图" }).click();
    assert.equal(await checkbox(fixtures[0]).isChecked(), true);
    assert.equal(await checkbox(fixtures[1]).isChecked(), false);
    passed.push("批量范围剔除隐藏项，不会恢复旧勾选；跨视图保留有效选项");
    await checkbox(fixtures[1]).check();
    const beforeMeta = await list();
    const beforeBackup = await (await api("backup/export")).json();
    await p.getByRole("button", { name: "修改分组", exact: true }).click();
    await p.getByLabel("目标分组", { exact: true }).fill("整理后的群岛");
    await p.getByRole("button", { name: "保存分组", exact: true }).click();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    const grouped = await list();
    assert.equal(
      grouped.find((a) => a.id === fixtures[0].id)!.group,
      "整理后的群岛",
    );
    assert.equal(
      grouped.find((a) => a.id === fixtures[1].id)!.group,
      "整理后的群岛",
    );
    await p.getByRole("button", { name: "撤销", exact: true }).click();
     const groupUndone = await list();
     assert.equal(groupUndone.find((a) => a.id === fixtures[0].id)!.group, "常用");
     passed.push("批量分组完成后可撤销，撤销只恢复分组字段");
     await checkbox(fixtures[0]).check();
     await checkbox(fixtures[1]).check();
     await p.getByRole("button", { name: "修改分组", exact: true }).click();
     await p.getByLabel("目标分组", { exact: true }).fill("整理后的群岛");
     await p.getByRole("button", { name: "保存分组", exact: true }).click();
     await p.getByRole("dialog").waitFor({ state: "hidden" });
     passed.push("列表批量分组成功，无额外查询");
    for (const mode of ["添加标签", "移除标签", "替换全部标签"]) {
      await checkbox(fixtures[0]).check();
      await checkbox(fixtures[1]).check();
      await p.getByRole("button", { name: "编辑标签", exact: true }).click();
      await choose("标签操作", mode);
      await p
        .getByLabel("标签（逗号分隔）", { exact: true })
        .fill(
          mode === "添加标签"
            ? "新标签, 常用"
            : mode === "移除标签"
              ? "常用"
              : "",
        );
      if (mode === "替换全部标签")
        await p.getByText(/此操作将覆盖每个已选账号的全部原标签/).waitFor();
      await p.getByRole("button", { name: "应用标签", exact: true }).click();
      await p.getByRole("dialog").waitFor({ state: "hidden" });
      const a = (await list()).find((a) => a.id === fixtures[0].id)!;
      assert.deepEqual(
        a.tags,
        mode === "添加标签"
          ? ["常用", "新标签"]
          : mode === "移除标签"
            ? ["新标签"]
            : [],
      );
    }
    await p.getByRole("button", { name: "撤销", exact: true }).click();
     assert.deepEqual((await list()).find((a) => a.id === fixtures[0].id)!.tags, ["新标签"]);
     await api("accounts/batch", "POST", {
       ids: [fixtures[0].id, fixtures[1].id],
       operation: { kind: "tags", mode: "replace", tags: [] },
     });
     passed.push("批量标签替换完成后可撤销，按账号恢复完整标签数组");
     passed.push("标签添加/移除/空替换含覆盖提醒，真实服务器状态一致");

    await checkbox(fixtures[0]).check();
    await checkbox(fixtures[1]).check();
    await p.getByRole("button", { name: "编辑标签", exact: true }).click();
    await p.getByLabel("标签（逗号分隔）").fill("错误不保存");
    await p.route("**/api/accounts/batch", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "夹具：账号正在查询" }),
      }),
    );
    await p.getByRole("button", { name: "应用标签", exact: true }).click();
    await p.getByRole("alert").filter({ hasText: "未确认保存" }).waitFor();
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await p.unroute("**/api/accounts/batch");
    assert.equal(await checkbox(fixtures[0]).isChecked(), true);
    assert.deepEqual(
      (await list()).find((a) => a.id === fixtures[0].id)!.tags,
      [],
    );
    passed.push("批量错误保留选择/弹窗输入，不宣称未知提交结果已保存");
    await p.getByRole("button", { name: "归档所选", exact: true }).click();
    assert.equal((await list()).filter((a) => a.archived).length, 0);
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal((await list()).filter((a) => a.archived).length, 0);
    await p.getByRole("button", { name: "归档所选", exact: true }).click();
    await p.getByRole("button", { name: "确认归档", exact: true }).click();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal((await list()).filter((a) => a.archived).length, 2);
     await p.getByRole("button", { name: "撤销", exact: true }).click();
     assert.equal((await list()).filter((a) => a.archived).length, 0);
     await checkbox(fixtures[0]).check();
     await checkbox(fixtures[1]).check();
     await p.getByRole("button", { name: "归档所选", exact: true }).click();
     await p.getByRole("button", { name: "确认归档", exact: true }).click();
     await p.getByRole("dialog").waitFor({ state: "hidden" });
     assert.equal((await list()).filter((a) => a.archived).length, 2);
     passed.push("批量归档完成后可撤销，撤销不改变余额与历史");
    await choose("档案范围", "已归档账号");
    await p
      .getByRole("checkbox", { name: "选择当前结果", exact: true })
      .check();
    await p.getByRole("button", { name: "取消归档所选", exact: true }).click();
    await p.getByRole("button", { name: "确认取消归档", exact: true }).click();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    await choose("档案范围", "使用中的账号");
    await p.locator(".filter-menu > summary").click();
    passed.push("归档须确认、取消不写，归档范围可批量恢复");
    const afterMeta = await list();
    const protectedFields = (a: Account) => {
      const { group, tags, archived, updatedAt, ...keep } = a;
      return keep;
    };
    assert.deepEqual(
      afterMeta.map(protectedFields),
      beforeMeta.map(protectedFields),
    );
    assert.deepEqual(
      (await (await api("backup/export")).json()).snapshots,
      beforeBackup.snapshots,
    );
    const secretStore = new Store(join(temp, "atlas.sqlite"), key);
    try {
      assert.equal(
        secretStore.credential(fixtures[0].id),
        "FIXTURE_ONLY_NEVER_QUERY",
      );
    } finally {
      secretStore.close();
    }
    const invalid = await api("accounts/batch", "POST", {
      ids: [fixtures[0].id, "00000000-0000-4000-8000-000000000001"],
      operation: { kind: "group", group: "不得落库" },
    });
    assert.equal(invalid.status(), 400);
    assert.deepEqual(await list(), afterMeta);
    passed.push("真实批量仅改元信息，余额/快照/诊断/凭据完整，未知ID整批拒绝");
    await stopServer();
    await startServer();
    await p.reload();
    await p.getByTestId("atlas-map").waitFor();
    assert.deepEqual(await list(), afterMeta);
    passed.push("重启独立生产进程后批量档案持久化");

    for (const total of [200, 500]) {
      seed(total);
      await p.reload();
      await p.getByTestId("atlas-map").waitFor();
      await settled();
      assert.equal(await p.locator("[data-node]").count(), total);
      const before = await positions(),
        svgBox = await p.locator(".atlas-svg").boundingBox();
      assert.ok(svgBox);
      const grid = Number(
        await p.getByTestId("atlas-map").getAttribute("data-grid-spacing"),
      );
      const background = await p.getByTestId("atlas-map").getAttribute("data-background");
      const minimumSpacing = background === "contours" ? 32 : 24;
      assert.ok(grid >= minimumSpacing && grid <= minimumSpacing * 2 + 0.01,
        `Performance fixture ${background} must retain its spacing range; measured ${grid}px`);
      const beforeZoom = await camera();
      await p.evaluate(
        "window.atlasCommits = 0; window.atlasPerf = {wheels:[],commits:[]}",
      );
      await p.mouse.move(
        svgBox.x + svgBox.width / 2,
        svgBox.y + svgBox.height / 2,
      );
      for (let i = 0; i < 20; i++) await p.mouse.wheel(0, -28);
      await p.waitForTimeout(350);
      const commits = (await p.evaluate("window.atlasCommits")) as number;
      const timing = await p.evaluate<{
        wheels: number[];
        commits: { at: number; panning: string | null }[];
      }>("window.atlasPerf");
      zoomTimelines.push({
        accounts: total,
        wheels: timing.wheels,
        commits: timing.commits,
      });
      assert.equal(timing.wheels.length, 20);
      assert.notEqual(
        await camera(),
        beforeZoom,
        "wheel input must move the camera",
      );
      assert.ok(
        // With activity kept outside React, staying on one LOD legitimately needs zero commits.
        commits >= 0 && commits <= 7,
        `${total} accounts: ${commits} commits for 20 wheels`,
      );
      assert.deepEqual(await positions(), before);
      const beforePan = await camera();
      await p.mouse.move(svgBox.x + 6, svgBox.y + svgBox.height - 110);
      await p.mouse.down();
      assert.equal(
        await p.getByTestId("atlas-map").getAttribute("data-panning"),
        "true",
      );
      await p.mouse.move(svgBox.x + 90, svgBox.y + svgBox.height - 160, {
        steps: 12,
      });
      await p.mouse.up();
      await p.waitForTimeout(250);
      assert.notEqual(await camera(), beforePan);
      assert.equal(
        await p.getByTestId("atlas-map").getAttribute("data-panning"),
        "false",
      );
      await p.mouse.move(0, 0);
      await p.waitForTimeout(1600);
      const rafBefore = (await p.evaluate("window.atlasRafCalls")) as number;
      await p.waitForTimeout(1100);
      const rafAfter = (await p.evaluate("window.atlasRafCalls")) as number;
      assert.equal(rafAfter, rafBefore);
      assert.equal(await p.evaluate("window.atlasRafs.size"), 0);
      metrics.push({
        accounts: total,
        zoomEvents: 20,
        reactCommits: commits,
        idleRafCalls: rafAfter - rafBefore,
      });
      await p.getByRole("button", { name: "显示全部站点" }).click();
      await p.waitForTimeout(400);
      await shot(`map-${total}-light.png`);
      passed.push(
        `${total} 账号稳定布局、20次滚轮按帧镜头、拖动结束与静置无RAF循环`,
      );
    }
    await p.getByRole("button", { name: "列表视图" }).click();
    await p.getByRole("button", { name: "批量管理", exact: true }).click();
    await p
      .getByRole("checkbox", { name: "选择当前结果", exact: true })
      .check();
    await p.getByText("已选 500 个", { exact: true }).waitFor();
    assert.equal(await p.locator(".site-row input:checked").count(), 500);
    await p.getByRole("button", { name: "清空选择", exact: true }).click();
    await p.getByText("已选 0 个", { exact: true }).waitFor();
    passed.push("500 账号列表全选/清空范围明确，未提交就不写入");
    await p.getByRole("button", { name: "设置", exact: true }).click();
    await p.getByRole("heading", { name: "数据与备份", exact: true }).waitFor();
    const backupExperience = p.getByTestId("backup-experience");
    await backupExperience.getByText("数据备份", { exact: true }).waitFor();
    await backupExperience.getByText("完整迁移", { exact: true }).waitFor();
    await backupExperience.getByText(/不含凭据/).waitFor();
    await backupExperience.getByText(/data\/atlas\.sqlite/).waitFor();
    await backupExperience.getByTestId("last-data-backup-export").getByText(/最近数据备份导出：/).waitFor();
    const exportResponse = p.waitForResponse(
      (response) =>
        response.url().endsWith("/api/backup/export") &&
        response.request().method() === "GET",
    );
    const exportStartedAt = Date.now();
    await p.getByRole("button", { name: "导出 JSON 备份", exact: true }).click();
    const exported = await (await exportResponse).json();
    const exportFinishedAt = Date.now();
    const exportedAt = Date.parse(exported.exportedAt);
    assert.ok(Number.isFinite(exportedAt), 'Backup export must include a valid timestamp');
    assert.equal(new Date(exportedAt).toISOString(), exported.exportedAt);
    assert.ok(exportedAt >= exportStartedAt && exportedAt <= exportFinishedAt,
      'Backup export timestamp must describe this export, not a fixed calendar day');
    const statusResponse = await api("backup/status");
    assert.equal(statusResponse.status(), 200);
    assert.equal((await statusResponse.json()).lastDataBackupExportAt, exported.exportedAt);
    await p.reload();
    await p.getByRole("button", { name: "设置", exact: true }).click();
    await p.getByRole("heading", { name: "数据与备份", exact: true }).waitFor();
    await p.getByTestId("last-data-backup-export").getByText(/最近数据备份导出：/).waitFor();
    assert.ok(!(await backupExperience.innerText()).includes("FIXTURE_ONLY_NEVER_QUERY"));
    passed.push("设置页区分数据备份/完整迁移并持久显示最近导出时间");
    for (const theme of ["light", "dark"]) {
      const settings = await api("settings", "PATCH", {
        theme,
        motion: true,
        mapBackground: "grid",
      });
      assert.equal(settings.status(), 200);
      await p.reload();
      for (const width of [1440, 768, 375]) {
        await p.setViewportSize({ width, height: 1000 });
        await p.getByRole("button", { name: "地图视图" }).click();
        await settled();
        await shot(`map-500-${theme}-${width}.png`);
        assert.ok(
          await p.evaluate(
            "document.documentElement.scrollWidth <= innerWidth + 1",
          ),
        );
        await p.getByRole("button", { name: "列表视图" }).click();
        await p.getByRole("button", { name: "批量管理", exact: true }).click();
        await p.getByLabel("搜索站点").fill("Alpha");
        await checkbox(fixtures[0]).check();
        await p.getByRole("button", { name: "编辑标签", exact: true }).click();
        await choose("标签操作", "替换全部标签");
        await shot(`batch-${theme}-${width}.png`, false);
        assert.ok(
          await p.evaluate(
            "document.documentElement.scrollWidth <= innerWidth + 1",
          ),
        );
        await p
          .getByRole("dialog")
          .getByRole("button", { name: "取消", exact: true })
          .click();
        await p
          .getByRole("button", { name: "退出批量管理", exact: true })
          .click();
        await p.getByLabel("搜索站点").fill("");
      }
    }
    passed.push("375/768/1440 浅深地图与批量菜单/替换提醒截图，无页面横向溢出");
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    await p.getByLabel("搜索站点").fill("Alpha");
    await p.getByRole("button", { name: "定位匹配站点" }).click();
    await shot("map-reduced-motion.png");
    await closeDetail();
    await p.getByLabel("搜索站点").fill("");
    assert.equal(
      await p.getByRole("button", { name: "定位匹配站点" }).count(),
      0,
    );
    const touch = await browser.newContext({
      viewport: { width: 375, height: 900 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
      storageState: await context.storageState(),
    });
    const phone = await touch.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    phone.on("request", (req) => {
      const url = new URL(req.url());
      if (
        /\/api\/(?:accounts\/[^/]+\/(?:sync|test)|query\/test)$/.test(
          url.pathname,
        )
      )
        externalQueries++;
      if (url.origin !== origin && ["http:", "https:"].includes(url.protocol))
        errors.push("unexpected touch browser network request");
    });
    await phone.goto(origin);
    await phone.getByTestId("site-list").waitFor();
    await phone.getByRole("button", { name: "地图视图" }).tap();
    await phone.getByTestId("atlas-map").waitFor();
    await phone.getByLabel("搜索站点").fill("Alpha");
    await phone.getByRole("button", { name: "定位匹配站点" }).tap();
    await phone.getByRole("complementary", { name: "当前账号详情" }).waitFor();
    await phone.getByRole("button", { name: "关闭账号详情" }).tap();
    await phone.getByLabel("搜索站点").fill("");
    await phone.getByRole("button", { name: "显示全部站点" }).tap();
    await phone.waitForTimeout(150);
    const phoneWorld = phone.getByTestId("map-world");
    const beforeTouchPan = await phoneWorld.getAttribute("transform");
    const phoneBox = await phone.locator(".atlas-svg").boundingBox();
    assert.ok(phoneBox);
    const cdp = await touch.newCDPSession(phone);
    try {
      const x = phoneBox.x + 6,
        y = phoneBox.y + phoneBox.height - 110;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 8; step++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + 9 * step, y: y - 4 * step }],
        });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await phone.waitForTimeout(150);
      assert.notEqual(
        await phoneWorld.getAttribute("transform"),
        beforeTouchPan,
      );
      assert.equal(
        await phone.getByTestId("atlas-map").getAttribute("data-panning"),
        "false",
      );
    } finally {
      await cdp.detach();
    }
    await phone.screenshot({
      path: join(out, "map-touch.png"),
      animations: "disabled",
    });
    screenshots.push("map-touch.png");
    assert.ok(
      await phone.evaluate(
        "document.documentElement.scrollWidth <= innerWidth + 1",
      ),
    );
    await touch.close();
    passed.push(
      "减少动效定位/关闭、触屏默认列表、点击定位与实际触摸平移完整可用",
    );
    const independent = new Store(join(temp, "atlas.sqlite"), key);
    try {
      for (const [i, a] of fixtures.entries())
        independent.batchUpdate({
          ids: [a.id],
          operation: {
            kind: "group",
            group: `独立群岛 ${String(i).padStart(3, "0")}`,
          },
        });
    } finally {
      independent.close();
    }
    await p.setViewportSize({ width: 375, height: 480 });
    await p.reload();
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    await p.getByRole("button", { name: "显示全部站点" }).click();
    await settled();
    assert.equal(await p.locator("[data-node]").count(), 500);
    assert.equal(await p.locator("[data-mini-group]").count(), 500);
    assert.equal(
      await p.evaluate(`(() => {
      const svg = document.querySelector('.atlas-svg'), b = svg.getBoundingClientRect();
      const origin = svg.createSVGPoint();
      return [...document.querySelectorAll('[data-node]')].every(n => {
        const point = origin.matrixTransform(n.getScreenCTM());
        return point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom;
      });
    })()`),
      true,
      "all 500 independent group node centers must fit in the actual SVG viewport",
    );
    await shot("map-500-independent-groups-375.png");
    passed.push("500 账号各一组采用二维布局，手机实际全图包含所有节点中心");
    const mixed = new Store(join(temp, "atlas.sqlite"), key);
    try {
      for (const a of fixtures.slice(0, 64))
        mixed.batchUpdate({
          ids: [a.id],
          operation: { kind: "group", group: "共享大组" },
        });
    } finally {
      mixed.close();
    }
    await p.reload();
    await p.getByRole("button", { name: "地图视图" }).click();
    await settled();
    assert.equal(await p.locator("[data-node]").count(), 500);
    assert.equal(await p.locator("[data-mini-group]").count(), 437);
    assert.equal(
      await p.evaluate(`(() => {
      const svg = document.querySelector('.atlas-svg'), b = svg.getBoundingClientRect();
      const origin = svg.createSVGPoint();
      return [...document.querySelectorAll('[data-node]')].every(n => {
        const point = origin.matrixTransform(n.getScreenCTM());
        return point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom;
      });
    })()`),
      true,
      "mixed large/single groups must all fit in the actual viewport",
    );
    await p.getByRole("button", { name: "放大地图" }).click();
    await p.getByRole("button", { name: "显示全部站点" }).click();
    await settled();
    await shot("map-500-mixed-groups-375.png");
    passed.push("64 个同组 + 436 个独立组按实际列宽布局，全图与缩放后复位完整");
    assert.equal(externalQueries, 0);
    assert.deepEqual(errors, []);
    passed.push("全部等待、保存、导航、缩放无余额/连接查询及浏览器错误");
  } catch (e) {
    failure = e;
    if (page)
      try {
        await page.screenshot({
          path: join(out, "failure.png"),
          fullPage: false,
          animations: "disabled",
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
    try {
      await stopServer();
    } catch {
      cleanupErrors.push("server cleanup");
    }
    try {
      assert.ok(
        resolve(temp).startsWith(
          resolve(tmpdir()) + sep + "atlas-management-ui-",
        ),
      );
      assert.equal(resolve(runtime), join(resolve(temp), "runtime"));
      if (existsSync(join(runtime, "node_modules")))
        unlinkSync(join(runtime, "node_modules"));
      rmSync(temp, { recursive: true, force: true });
    } catch {
      cleanupErrors.push("isolated runtime cleanup");
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
            : cleanupErrors.length
              ? "FAIL"
              : "PASS",
          buildId,
          isolatedRuntimeWithoutEnvFiles: true,
          passed,
          metrics,
          zoomTimelines,
          externalQueries,
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
        externalQueries,
        errors,
        cleanupErrors,
        metrics,
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




