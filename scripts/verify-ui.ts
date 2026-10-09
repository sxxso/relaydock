import { chromium, type Locator, type Page } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
import { verifyGroupColorEditor, verifyDarkAndMobileColorEditor, verifyLoadingSkeleton, verifyReducedColorMotion, recordMotionShowcase } from "./verify-colors";
import { verifyColorFailureRecovery, verifyFirstAccountRead, verifyStaleColorRead, verifySessionReadiness } from "./verify-colors";
import { verifyToolbarMenus, verifyUndoRecovery } from "./verify-toolbar";
import { verifyMapChrome } from "./verify-map-chrome";
/** Check the rendered colours, including inherited button text, not CSS source strings. */
function textContrast(foreground: string, background: string) {
  const luminance = (colour: string) => {
    const channels = colour.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    assert.ok(channels?.length === 3, `Expected computed RGB colour: ${colour}`);
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
async function assertToastReadable(toast: Locator, context: string) {
  await toast.waitFor();
  const colours = await toast.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      foreground: style.color,
      background: style.backgroundColor,
      fontSize: parseFloat(style.fontSize),
      controls: Array.from(element.querySelectorAll("button")).map((button) => ({
        label: button.getAttribute("aria-label") || button.textContent || "button",
        foreground: getComputedStyle(button).color,
      })),
    };
  });
  assert.ok(colours.fontSize >= 12, `${context}: notification text must be at least 12px`);
  for (const item of [{ label: "message", foreground: colours.foreground }, ...colours.controls]) {
    const ratio = textContrast(item.foreground, colours.background);
    assert.ok(ratio >= 4.5, `${context} ${item.label}: contrast ${ratio.toFixed(2)}:1 (${item.foreground} on ${colours.background})`);
  }
}
async function assertMapReadable(page: Page) {
  const nodes = await page.locator(".map-node").evaluateAll((elements) => elements.map((node) => ({
    id: node.getAttribute("data-account-id"),
    fill: getComputedStyle(node.querySelector(".node-core")!).fill,
    initial: getComputedStyle(node.querySelector(".node-initial")!).fill,
    low: node.classList.contains("is-low"),
    warning: !!node.querySelector(".node-warning"),
  })));
  const ordinaryFills = nodes.filter((node) => !node.low).map((node) => node.fill);
  assert.ok(new Set(ordinaryFills).size >= 2, `Different groups must not all share one node colour: ${ordinaryFills.join(", ")}`);
  for (const node of nodes) {
    assert.ok(textContrast(node.initial, node.fill) >= 4.5, "Node initials must remain readable on every group colour");
    if (node.low) assert.ok(node.warning, "Low balance must retain its warning badge independently of group colour");
  }
  return nodes;
}
async function main() {
  const root = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "atlas-e2e-")),
    out = join(root, "output", "playwright");
  mkdirSync(out, { recursive: true });
  const runtime = join(temp, "runtime");
  copyIsolatedBuild(root, runtime);
  const buildId = readFileSync(
    join(runtime, ".next", "BUILD_ID"),
    "utf8",
  ).trim();
  const port = Number(process.env.ATLAS_E2E_PORT || 3317),
    origin = `http://127.0.0.1:${port}`,
    password = "fixture-admin-password-123";
  let hits = 0;
  const fixture = createServer((req, res) => {
    hits++;
    assert.equal(req.headers.authorization, "Bearer fixture-secret");
    assert.equal(req.headers["new-api-user"], "123");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data: { quota: 43625000 } }));
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  let fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const server = spawn(
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
        // Exercise the documented local setup without a configured public URL.
        RELAYDOCK_PUBLIC_URL: "",
        RELAYDOCK_PRIVATE_HOSTS: "127.0.0.1",
        RELAYDOCK_DNS_MODE: "system",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  server.stdout.on("data", (b) => (logs += String(b)));
  server.stderr.on("data", (b) => (logs += String(b)));
  let pageForFailure: import("playwright").Page | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    passed: string[] = [],
    errors: string[] = [];
  try {
    for (let i = 0; i < 100; i++) {
      try {
        let r = await fetch(origin + "/api/auth/session");
        if (r.ok) break;
      } catch {}
      if (i === 99) throw new Error("测试服务没有启动：" + logs);
      await new Promise((r) => setTimeout(r, 300));
    }
    browser = await chromium.launch({
      headless: true,
      env: cleanRuntimeEnv() as Record<string, string>,
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
      }),
      page = await context.newPage();
    pageForFailure = page;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      let u = new URL(r.url());
      if (!["127.0.0.1", "localhost"].includes(u.hostname))
        errors.push("unexpected external browser request: " + u.hostname);
    });
    await verifyLoadingSkeleton(page, origin, out);
    passed.push("加载骨架与几何动效，无旧加载器叠加");
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await verifyFirstAccountRead(page, () => page.getByRole("button", { name: "进入我的群岛" }).click(), out);
    await page.getByRole("button", { name: "添加第一个站点" }).waitFor();
    assert.equal(hits, 0);
    passed.push("登录与真实空状态，无外部查询");
    await page.getByRole("button", { name: "添加第一个站点" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByLabel("站点名称").fill("North API");
    await dialog.getByLabel("网站地址").fill("https://north.example");
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByRole("button", { name: "继续确认单位" }).click();
    await dialog.getByLabel("初始余额").fill("86.40");
    await dialog.getByLabel("我已确认余额单位与查询口径").check();
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByRole("button", { name: "保存站点" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator("[data-node]").first().click();
    await page.getByRole("button", { name: "记录余额", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("余额 / USD").fill("87.25");
    await dialog.getByLabel("记录备注").fill("本机夹具测试记录");
    await dialog.getByRole("button", { name: "保存记录" }).click();
    await dialog.waitFor({ state: "hidden" });
    await assertToastReadable(page.locator(".toast"), "desktop light");
    await page.locator(".toast").screenshot({ path: join(out, "toast-light.png") });
    passed.push("新增档案与手动余额快照");
    const session = await (
      await context.request.get(origin + "/api/auth/session")
    ).json();
    async function api(path: string, method = "GET", data?: unknown) {
      let r = await context.request.fetch(origin + "/api/" + path, {
        method,
        headers: { Origin: origin, "x-csrf-token": session.csrf },
        ...(data === undefined ? {} : { data }),
      });
      let b = await r.json();
      assert.ok(r.ok(), `${method} ${path}: ${JSON.stringify(b)}`);
      return b;
    }
    let account = (await api("accounts")).accounts[0];
    await page.getByRole("button", { name: "编辑档案" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "记录方式" }).click();
    await page
      .getByRole("option", { name: "New API · 账户余额", exact: false })
      .click();
    await dialog.getByLabel("管理接口根地址").fill(fixtureOrigin);
    await dialog.getByLabel("用户 ID").fill("123");
    await dialog
      .getByLabel("用户管理令牌", { exact: true })
      .fill("fixture-secret");
    await dialog.getByLabel("每单位对应的原始配额").fill("500000");
    await dialog.getByLabel("我已确认换算系数和余额单位").check();
    await dialog.getByRole("button", { name: "保存站点" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(hits, 0);
    await page.getByRole("button", { name: "测试连接" }).click();
    await page.getByRole("status").filter({ hasText: "连接成功" }).waitFor();
    assert.equal(hits, 1);
    assert.equal(
      (await api(`accounts/${account.id}/history`)).snapshots.length,
      2,
    );
    await page
      .locator(".account-detail")
      .getByRole("button", { name: "刷新余额", exact: true })
      .click();
    await page.getByRole("status").filter({ hasText: "余额已同步" }).waitFor();
    assert.equal(hits, 2);
    assert.equal(
      (await api(`accounts/${account.id}/history`)).snapshots.length,
      3,
    );
    passed.push("New API 只在点击时查询；测试连接不改余额；成功同步留快照");
    const fixtures = [
      { name: "Orbit Relay", balance: "32.50", group: "备用" },
      { name: "Lumen Gate", balance: "18.70", group: "常用" },
      { name: "Nova Lab", balance: "5.20", group: "实验" },
    ];
    for (const f of fixtures)
      await api("accounts", "POST", {
        name: f.name,
        siteUrl: "https://" + f.name.split(" ")[0].toLowerCase() + ".example",
        provider: "manual",
        unit: "USD",
        initialBalance: f.balance,
        group: f.group,
        lowThreshold: f.name === "Nova Lab" ? "10" : null,
      });
    await page.reload();
    await page.locator("[data-node]").first().waitFor();
    assert.equal(await page.locator("[data-node]").count(), 4);
    if (process.env.ATLAS_MAP_CHROME_FOCUS) {
      await verifyMapChrome(page, out);
      console.log("PASS isolated map chrome regression"); return;
    }
    if (process.env.ATLAS_TOOLBAR_FOCUS) {
      if (process.env.ATLAS_TOOLBAR_FOCUS === "menus") await verifyToolbarMenus(page, api, out);
      else await verifyUndoRecovery(page, api, out);
      console.log(`PASS ${process.env.ATLAS_TOOLBAR_FOCUS} toolbar/undo checks`); return;
    }
    await verifyMapChrome(page, out);
    passed.push("地图控件单一方框、按钮对齐，小地图取景框/说明清晰且浅深手机无碰撞");
    await verifyToolbarMenus(page, api, out);
    passed.push("长下拉列表和短屏筛选面板可见、可滚动、键盘可达");
    await verifyUndoRecovery(page, api, out);
    passed.push("撤销不被普通提示覆盖，失败可重试，聚焦和等待请求暂停过期，旧结果不清除新动作");
    await verifyGroupColorEditor(page, api, out);
    if (process.env.ATLAS_COLOR_FOCUS !== "auth") {
      if (process.env.ATLAS_COLOR_FOCUS !== "stale") await verifyColorFailureRecovery(page, api);
      await verifyStaleColorRead(page, api);
    }
    await verifySessionReadiness(page, password);
    Object.assign(session, await (await context.request.get(origin + "/api/auth/session")).json());
    if (process.env.ATLAS_COLOR_FOCUS) { console.log(`PASS ${process.env.ATLAS_COLOR_FOCUS} focused colour/loading regression checks`); return; }
    passed.push("颜色保存失败可取消、并发冲突不覆盖；过期与跨会话读取不误清颜色或结束加载");
    await recordMotionShowcase(page, origin, out);
    passed.push("分组颜色预览、取消、HEX 校验、保存刷新、改名保留、小地图同步与恢复默认");
    const mapNodes = await assertMapReadable(page);
    const paletteAccounts = (await api("accounts")).accounts as { id: string; group: string }[];
    const colourByGroup = new Map<string, string>();
    for (const node of mapNodes) {
      const group = paletteAccounts.find((item) => item.id === node.id)!.group;
      if (colourByGroup.has(group)) assert.equal(node.fill, colourByGroup.get(group), "Accounts in the same group must share one visual identity");
      else colourByGroup.set(group, node.fill);
    }
    passed.push("站点按分组区分配色，节点文字可读且低余额警示保留");
    const firstId = mapNodes.find((node) => node.id === account.id)?.id;
    assert.ok(firstId, "Fixture account must remain visible on the map");
    const firstNode = page.locator(`[data-account-id="${firstId}"]`);
    const originalFill = await firstNode.locator(".node-core").evaluate((node) => getComputedStyle(node).fill);
    await firstNode.click();
    assert.equal(await firstNode.locator(".node-core").evaluate((node) => getComputedStyle(node).fill), originalFill, "Selection must not turn the group colour back into orange");
    await page.getByRole("button", { name: "收藏账号", exact: true }).click();
    await page.locator(".toast-undo").waitFor();
    await assertToastReadable(page.locator(".toast"), "light notification with undo");
    await page.locator(".toast").screenshot({ path: join(out, "toast-undo-light.png") });
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.locator(".toast-undo").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "关闭账号详情" }).click();
    const orbitNode = mapNodes.find((node) => node.id !== account.id && !node.low)!;
    const remainingAccounts = (await api("accounts")).accounts;
    const orbitGroup = remainingAccounts.find((item: { id: string }) => item.id === orbitNode.id).group;
    await page.getByRole("combobox", { name: "筛选分组", exact: true }).click();
    await page.getByRole("option", { name: orbitGroup, exact: true }).click();
    assert.equal(await page.locator(`[data-account-id="${orbitNode.id}"] .node-core`).evaluate((node) => getComputedStyle(node).fill), orbitNode.fill, "Filtering groups must not reassign their colours");
    await page.getByRole("combobox", { name: "筛选分组", exact: true }).click();
    await page.getByRole("option", { name: "所有分组", exact: true }).click();
    passed.push("通知撤销按钮文字清晰，分组颜色在选中与筛选后保持不变");
    await page.getByRole("button", { name: "显示全部站点" }).click();
    await page.waitForTimeout(450);
    await page.screenshot({
      path: join(out, "desktop-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "列表视图" }).click();
    assert.equal(await page.locator(".site-row").count(), 4);
    const avatars = await page.locator(".site-row .site-avatar").evaluateAll((elements) => elements.map((element) => ({
      colour: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    })));
    assert.ok(new Set(avatars.map((avatar) => avatar.background)).size >= 3, "List avatars must use the same group palette instead of all orange");
    for (const avatar of avatars) assert.ok(textContrast(avatar.colour, avatar.background) >= 4.5, `List avatar initials must remain readable (${avatar.colour} on ${avatar.background})`);
    await page.locator(".site-list").evaluate(async (list) => {
      await Promise.all(list.getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: join(out, "list-group-colours-light.png"), fullPage: true });
    await page.getByRole("button", { name: "只看收藏" }).click();
    await page
      .getByRole("heading", { name: "这片视野里，还没有站点" })
      .waitFor();
    await page.getByRole("button", { name: "清除筛选" }).click();
    passed.push("地图/列表与筛选共享数据");
    await page.getByRole("button", { name: "余额记录", exact: true }).click();
    await page.getByRole("heading", { name: "余额留下的足迹" }).waitFor();
    await page.getByRole("combobox", { name: "历史账号" }).click();
    await page
      .getByRole("option", { name: "全部账号（仅列表）", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".records-table tbody tr").length === 6,
    );
    assert.equal(await page.locator(".records-table tbody tr").count(), 6);
    await page.waitForTimeout(450);
    await page.screenshot({
      path: join(out, "history-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("夜墨色").check();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    await page.waitForTimeout(450);
    await page.screenshot({
      path: join(out, "settings-dark.png"),
      fullPage: true,
    });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 JSON 备份" }).click();
    let download = await downloadPromise;
    await download.saveAs(join(out, "fixture-backup.json"));
    await assertToastReadable(page.locator(".toast"), "desktop dark");
    await page.locator(".toast").screenshot({ path: join(out, "toast-dark.png") });
    let backup = await api("backup/export");
    assert.ok(!JSON.stringify(backup).includes("fixture-secret"));
    assert.ok(!JSON.stringify(backup).includes("adminHash"));
    let remove = backup.accounts.find(
      (a: { details: { name: string } }) => a.details.name === "Orbit Relay",
    );
    await api(`accounts/${remove.id}`, "DELETE");
    await page.locator("input[type=file]").setInputFiles({
      name: "restore.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await page.getByRole("heading", { name: "导入预览" }).waitFor();
    await page.getByRole("button", { name: "确认导入" }).click();
    await page.getByRole("status").filter({ hasText: "备份已导入" }).waitFor();
    assert.equal((await api("accounts")).accounts.length, 4);
    passed.push("脱敏导出、预览与事务导入恢复");
    await page.getByRole("button", { name: "站点", exact: true }).click();
    await page.getByRole("button", { name: "地图视图" }).click();
    await assertMapReadable(page);
    await verifyDarkAndMobileColorEditor(page, api, out);
    passed.push("深色主题分组配色与节点文字对比度通过");
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
      await page.getByRole("button", { name: "显示全部站点" }).click();
      await page.waitForTimeout(450);
      await page.screenshot({
        path: join(out, `map-dark-${width}.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "dark page overflow " + width,
      );
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "列表视图" }).click();
    await page.locator(".site-identity").first().click();
    await page.locator(".account-detail").waitFor();
    await page.getByRole("button", { name: "记录余额", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("余额 / USD").fill("18.70");
    await dialog.getByRole("button", { name: "保存记录" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".toast").waitFor();
    await page.waitForTimeout(450);
    await assertToastReadable(page.locator(".toast"), "mobile dark with detail");
    const detailBox = await page.locator(".account-detail").boundingBox();
    const toastBox = await page.locator(".toast").boundingBox();
    assert.ok(detailBox && toastBox);
    assert.ok(
      toastBox.y + toastBox.height <= detailBox.y ||
        toastBox.y >= detailBox.y + detailBox.height,
      "mobile status toast must not cover the account detail or its actions",
    );
    const headerBox = await page.locator(".app-header").boundingBox();
    assert.ok(headerBox);
    assert.ok(
      toastBox.y >= headerBox.y + headerBox.height ||
        toastBox.y + toastBox.height <= headerBox.y,
      "mobile status toast must also leave the main navigation unobscured",
    );
    passed.push("手机通知不遮挡导航或底部详情面板");
    passed.push("浅深主题通知正文与关闭按钮对比度至少 4.5:1，手机文字不少于 12px");
    await page.screenshot({
      path: join(out, "mobile-detail-dark.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭账号详情" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("暖纸面").check();
    await page.getByLabel("装饰动效").uncheck();
    await page.getByRole("button", { name: "站点", exact: true }).click();
    await page.getByRole("button", { name: "地图视图" }).click();
    await verifyReducedColorMotion(page);
    assert.equal(
      await page.locator("canvas").getAttribute("data-animating"),
      "false",
    );
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
      await page.getByRole("button", { name: "显示全部站点" }).click();
      await page.waitForTimeout(450);
      await page.screenshot({
        path: join(out, `map-light-${width}.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "light page overflow " + width,
      );
    }
    passed.push("375/768/1440 浅深主题截图，无页面横向溢出");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("装饰动效").check();
    await page.getByRole("button", { name: "站点", exact: true }).click();
    let mapBox = await page.locator(".atlas-map").boundingBox();
    assert.ok(mapBox);
    await page.mouse.move(mapBox!.x + 40, mapBox!.y + 40);
    await page.mouse.move(mapBox!.x + 90, mapBox!.y + 90);
    await page.waitForFunction(
      () =>
        document.querySelector("canvas")?.getAttribute("data-animating") ===
        "false",
      undefined,
      { timeout: 2000 },
    );
    assert.equal(hits, 2);
    passed.push("背景静置停帧，页面切换和等待不触发查询");
    for (let i = 0; i < 46; i++)
      await api("accounts", "POST", {
        name:
          i === 0
            ? "非常长的站点名称与账号信息也需要保持可读的测试站点"
            : `测试站点 ${i + 1}`,
        siteUrl: "https://fixture.example",
        unit: i % 3 === 0 ? "CNY" : "USD",
        group: ["常用", "备用", "实验", "工具", "其他"][i % 5],
        initialBalance: i % 2 === 0 ? "0" : null,
      });
    await page.reload();
    await page.locator("[data-node]").first().waitFor();
    assert.equal(await page.locator("[data-node]").count(), 50);
    await assertMapReadable(page);
    await page.waitForTimeout(450);
    await page.screenshot({
      path: join(out, "fifty-accounts.png"),
      fullPage: true,
    });
    passed.push("50 账号、长名称、零余额与未知余额");
    const touch = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    await touch.addCookies(await context.cookies());
    let mobile = await touch.newPage();
    await mobile.goto(origin);
    await mobile.locator(".site-row").first().waitFor();
    assert.equal(await mobile.locator(".site-row").count(), 50);
    await mobile.getByRole("button", { name: "地图视图" }).click();
    assert.equal(
      await mobile.locator("canvas").getAttribute("data-animating"),
      "false",
    );
    passed.push("触屏默认列表，减少动效模式可用");
    await verifyReducedColorMotion(mobile);
    passed.push("自定义颜色编辑在手机、深色及系统/应用关闭动效时可用");
    await touch.close();
    assert.deepEqual(errors, []);
    writeFileSync(
      join(out, "verification.json"),
      JSON.stringify(
        {
          passed,
          buildId,
          isolatedRuntimeWithoutEnvFiles: true,
          errors,
          fixtureRequests: hits,
          screenshotsDirectory: out,
          realProviderVerified: false,
          dockerVerified: false,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ passed, errors, fixtureRequests: hits }, null, 2),
    );
  } catch (error) {
    if (pageForFailure) {
      await pageForFailure
        .screenshot({ path: join(out, "failure.png"), fullPage: true })
        .catch(() => {});
      writeFileSync(
        join(out, "failure-dom.txt"),
        await pageForFailure.content(),
      );
    }
    console.error("Completed checkpoints:", passed);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      let exited = new Promise((r) => server.once("exit", r));
      server.kill();
      await exited;
    }
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
    writeFileSync(join(out, "server-log.txt"), logs);
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith("atlas-e2e-"));
    assert.equal(resolve(runtime), join(resolve(temp), "runtime"));
    unlinkSync(join(runtime, "node_modules"));
    rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
