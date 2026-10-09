import type { Page } from "playwright";
import assert from "node:assert/strict";
import { join } from "node:path";
import { colorContrast } from "../src/lib/group-colors";

type Api = (path: string, method?: string, data?: unknown) => Promise<any>;
async function assertButtonContrast(button: import("playwright").Locator) {
  const style = await button.evaluate((node) => ({ foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
  const hex = (rgb: string) => "#" + rgb.match(/[\d.]+/g)!.slice(0, 3).map((value) => Math.round(Number(value)).toString(16).padStart(2, "0")).join("");
  const ratio = colorContrast(hex(style.foreground), hex(style.background));
  assert.ok(ratio >= 4.5, `Save button contrast must be at least 4.5:1, got ${ratio.toFixed(2)}:1`);
}
export async function verifyGroupColorEditor(page: Page, api: Api, out: string) {
  await page.getByRole("button", { name: "分组颜色", exact: true }).click({ timeout: 5000 });
  let dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  const chooseGroup = async () => {
    await dialog.getByRole("combobox", { name: "颜色所属分组" }).click();
    await page.getByRole("option", { name: "常用", exact: true }).click();
  };
  await chooseGroup();
  const before = (await api("accounts")).groupColors;
  await dialog.getByLabel("HEX 色值", { exact: true }).fill("#FFFFFF");
  assert.equal(await dialog.getByTestId("color-preview-node").evaluate((node) => getComputedStyle(node).fill), "rgb(255, 255, 255)");
  assert.equal((await api("accounts")).groupColors.revision, before.revision, "Preview must not write to storage");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual((await api("accounts")).groupColors, before);

  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  await chooseGroup();
  await dialog.getByLabel("HEX 色值", { exact: true }).fill("var(--ink)");
  assert.equal(await dialog.getByRole("button", { name: "保存颜色", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "梅紫", exact: true }).click();
  const hex = await dialog.getByLabel("HEX 色值", { exact: true }).inputValue();
  assert.equal(hex, "#754A80");
  await assertButtonContrast(dialog.getByRole("button", { name: "保存颜色", exact: true }));
  await dialog.screenshot({ path: join(out, "group-color-editor-light.png") });
  await dialog.getByRole("button", { name: "保存颜色", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await api("accounts")).groupColors.colors.find((entry: { name: string }) => entry.name === "常用").color, hex);
  const id = (await api("accounts")).accounts.find((a: { group: string }) => a.group === "常用").id;
  const coreFill = async () => page.locator(`[data-account-id="${id}"] .node-core`).evaluate((node) => getComputedStyle(node).fill);
  assert.equal(await coreFill(), "rgb(117, 74, 128)");
  const islandFill = await page.locator('[data-island-group="常用"] .island-wash').evaluate((node) => getComputedStyle(node).fill);
  const miniFill = await page.locator('[data-mini-group="常用"] .minimap-island').evaluate((node) => getComputedStyle(node).fill);
  assert.equal(miniFill, islandFill, "Minimap and map must share the custom wash");
  await page.reload();
  await page.locator(`[data-account-id="${id}"]`).waitFor();
  assert.equal(await coreFill(), "rgb(117, 74, 128)");
  await page.getByRole("button", { name: "列表视图" }).click();
  const avatar = page.locator('.site-row').filter({ hasText: "Lumen Gate" }).locator(".site-avatar");
  assert.equal(await avatar.evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(117, 74, 128)");
  await page.getByRole("button", { name: "地图视图" }).click();

  await page.getByLabel("更多筛选").click();
  await page.getByRole("button", { name: "分组改名", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "分组改名", exact: true });
  await dialog.getByRole("combobox", { name: "需要改名的分组" }).click();
  await page.getByRole("option", { name: /^常用/ }).click();
  await dialog.getByLabel("新的分组名称").fill("常用配色");
  await dialog.getByRole("button", { name: "保存分组名称" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await coreFill(), "rgb(117, 74, 128)");
  const saved = await api("backup/export");
  assert.equal(saved.groupColors.find((entry: { name: string }) => entry.name === "常用配色").color, hex);

  // White/custom colours preserve an outline and receive readable auto text.
  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  await dialog.getByRole("combobox", { name: "颜色所属分组" }).click();
  await page.getByRole("option", { name: "常用配色", exact: true }).click();
  await dialog.getByLabel("HEX 色值", { exact: true }).fill("#FFFFFF");
  await assertButtonContrast(dialog.getByRole("button", { name: "保存颜色", exact: true }));
  const previewText = await dialog.getByTestId("color-preview-initial").evaluate((node) => getComputedStyle(node).fill);
  const channels = previewText.match(/\d+/g)!.slice(0, 3).map(Number);
  assert.ok(colorContrast("#" + channels.map((v) => v.toString(16).padStart(2, "0")).join(""), "#FFFFFF") >= 4.5);
  await dialog.getByRole("button", { name: "恢复默认", exact: true }).click();
  await dialog.getByRole("button", { name: "保存颜色", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.ok(!(await api("accounts")).groupColors.colors.some((entry: { name: string }) => entry.name === "常用配色"));
  // Put the original fixture name back for subsequent generic scenarios.
  const layout = (await api("accounts")).groupLayout;
  await api("map/groups/rename", "POST", { name: "常用配色", newName: "常用", expectedRevision: layout.revision });
  await page.reload();
  await page.locator("[data-node]").first().waitFor();

  // Simulate a second tab winning a save while the editor is open.
  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  await chooseGroup();
  await dialog.getByRole("button", { name: "海蓝", exact: true }).click();
  const stale = (await api("accounts")).groupColors;
  await api("map/groups/color", "POST", { name: "常用", color: "#111111", expectedRevision: stale.revision });
  await dialog.getByRole("button", { name: "保存颜色", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "其他页面更新" }).waitFor();
  assert.equal((await api("accounts")).groupColors.colors.find((entry: { name: string }) => entry.name === "常用").color, "#111111");
  assert.equal(await dialog.getByLabel("HEX 色值", { exact: true }).inputValue(), "#2D648C", "A conflict must retain the draft");
  await dialog.getByRole("button", { name: "保存颜色", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await api("accounts")).groupColors.colors.find((entry: { name: string }) => entry.name === "常用").color, "#2D648C");
  const winner = (await api("accounts")).groupColors;
  await api("map/groups/color", "POST", { name: "常用", color: null, expectedRevision: winner.revision });
  await page.reload();
  await page.locator("[data-node]").first().waitFor();
}

export async function verifyColorFailureRecovery(page: Page, api: Api) {
  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  await dialog.getByRole("combobox", { name: "颜色所属分组" }).click();
  await page.getByRole("option", { name: "常用", exact: true }).click();
  await dialog.getByRole("button", { name: "海蓝", exact: true }).click();
  const before = (await api("accounts")).groupColors;
  let captured!: () => void, release!: () => void, finish!: () => void;
  const fetched = new Promise<void>((resolve) => { captured = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const handled = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/map/groups/color", (route) => route.fulfill({ status: 503, json: { error: "暂时无法保存，请重试" } }), { times: 1 });
  await page.route("**/api/accounts", async (route) => {
    try { captured(); await held; await route.fulfill({ status: 200, json: await api("accounts") }); }
    finally { finish(); }
  }, { times: 1 });
  try {
    await dialog.getByRole("button", { name: "保存颜色", exact: true }).click();
    await fetched;
    assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).isDisabled(), false, "A failed save must not trap the user behind a hanging recovery read");
    await dialog.getByRole("alert").filter({ hasText: "暂时无法保存" }).waitFor();
    await api("map/groups/color", "POST", { name: "常用", color: "#111111", expectedRevision: before.revision });
    release(); await handled;
    await page.unrouteAll({ behavior: "wait" });
    await dialog.getByRole("button", { name: "保存颜色", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "其他页面更新" }).waitFor();
    assert.equal((await api("accounts")).groupColors.colors.find((entry: { name: string }) => entry.name === "常用").color, "#111111", "A generic failure must not silently advance the draft revision");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  } finally {
    release(); await handled; await page.unrouteAll({ behavior: "wait" });
    const current = (await api("accounts")).groupColors;
    await api("map/groups/color", "POST", { name: "常用", color: null, expectedRevision: current.revision });
  }
  await page.reload(); await page.locator("[data-node]").first().waitFor();
}

export async function verifyStaleColorRead(page: Page, api: Api) {
  const fixture = await api("accounts", "POST", { name: "Colour read fixture", group: "读取夹具", siteUrl: "https://colour-read.example", initialBalance: "1", provider: "manual", unit: "USD" });
  const colors = (await api("accounts")).groupColors;
  await api("map/groups/color", "POST", { name: "读取夹具", color: "#754A80", expectedRevision: colors.revision });
  await page.reload(); await page.locator(`[data-account-id="${fixture.id}"]`).waitFor();
  await page.locator(`[data-account-id="${fixture.id}"]`).focus();
  await page.keyboard.press("Enter");
  let release!: () => void, captured!: () => void, finish!: () => void;
  const held = new Promise<void>((r) => { release = r; }), fetched = new Promise<void>((r) => { captured = r; }), handled = new Promise<void>((r) => { finish = r; });
  await page.route("**/api/accounts", async (route) => {
    try {
      const response = await route.fetch(), body = await response.json();
      // A filtered-out group may disappear/reappear without a colour revision bump.
      body.groupColors.colors = body.groupColors.colors.filter((entry: { name: string }) => entry.name !== "读取夹具");
      captured(); await held; await route.fulfill({ response, json: body });
    } finally { finish(); }
  }, { times: 1 });
  const record = async (amount: string) => {
    await page.getByRole("button", { name: "记录余额", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("余额 / USD").fill(amount);
    await dialog.getByRole("button", { name: "保存记录", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  try {
    await record("2"); await fetched;
    await record("3");
    await page.waitForFunction((id) => document.querySelector(`[data-account-id="${id}"]`)?.getAttribute("aria-label")?.includes("$3.00"), fixture.id);
    release(); await handled;
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    assert.equal(await page.locator(`[data-account-id="${fixture.id}"] .node-core`).evaluate((node) => getComputedStyle(node).fill), "rgb(117, 74, 128)", "An older same-revision read must not remove a newer group colour");
  } finally {
    release(); await handled; await page.unrouteAll({ behavior: "wait" });
    const model = (await api("accounts")).groupColors;
    await api("map/groups/color", "POST", { name: "读取夹具", color: null, expectedRevision: model.revision });
    await api(`accounts/${fixture.id}`, "DELETE");
  }
  await page.reload(); await page.locator("[data-node]").first().waitFor();
}

export async function verifySessionReadiness(page: Page, password: string) {
  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  await dialog.getByRole("button", { name: "梅紫", exact: true }).click();
  let releaseOld!: () => void, releaseNew!: () => void, captureOld!: () => void, captureNew!: () => void, finishOld!: () => void, finishNew!: () => void;
  const oldGate = new Promise<void>((r) => { releaseOld = r; }), newGate = new Promise<void>((r) => { releaseNew = r; });
  const oldFetched = new Promise<void>((r) => { captureOld = r; }), newFetched = new Promise<void>((r) => { captureNew = r; });
  const oldDone = new Promise<void>((r) => { finishOld = r; }), newDone = new Promise<void>((r) => { finishNew = r; });
  await page.route("**/api/map/groups/color", (route) => route.fulfill({ status: 503, json: { error: "暂时无法保存" } }), { times: 1 });
  let reads = 0;
  // Keep interception enabled until BOTH held reads finish. Expiring one-shot
  // handlers can disable Chromium interception and release the other request.
  await page.route("**/api/accounts", async (route) => {
    const read = ++reads;
    if (read > 2) return route.continue();
    try {
      const response = await route.fetch(), body = await response.json();
      if (read === 1) { captureOld(); await oldGate; }
      else { captureNew(); await newGate; }
      await route.fulfill({ response, json: body });
    } finally { (read === 1 ? finishOld : finishNew)(); }
  });
  try {
    await dialog.getByRole("button", { name: "保存颜色", exact: true }).click(); await oldFetched;
    await dialog.getByRole("alert").waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "进入我的群岛" }).click(); await newFetched;
    await page.locator(".workspace-loading").waitFor();
    assert.equal(reads, 2, "Only the old recovery read and the new session read should be pending");
    const oldResponse = page.waitForResponse((response) => response.url().endsWith("/api/accounts"));
    releaseOld(); await oldDone;
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    assert.equal(await page.locator(".workspace-loading").count(), 1, "An old session read must not finish the current account loading state");
    assert.equal(await page.locator(".empty-state").count(), 0);
  } finally {
    releaseOld(); releaseNew();
    if (reads >= 1) await oldDone;
    if (reads >= 2) await newDone;
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.locator("[data-node]").first().waitFor();
}

export async function verifyFirstAccountRead(page: Page, onLogin: () => Promise<void>, out: string) {
  let release!: () => void, captured!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fetched = new Promise<void>((resolve) => { captured = resolve; });
  await page.route("**/api/accounts", async (route) => { captured(); await held; await route.continue(); }, { times: 1 });
  try {
    await onLogin(); await fetched;
    await page.locator(".workspace-loading").waitFor();
    assert.equal(await page.getByRole("button", { name: "添加第一个站点" }).count(), 0, "Do not claim an empty workspace until account data is read");
    await page.screenshot({ path: join(out, "account-read-skeleton.png") });
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
}

export async function verifyDarkAndMobileColorEditor(page: Page, api: Api, out: string) {
  const viewport = page.viewportSize()!;
  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  await dialog.getByRole("combobox", { name: "颜色所属分组" }).click();
  await page.getByRole("option", { name: "常用", exact: true }).click();
  await dialog.getByLabel("HEX 色值", { exact: true }).fill("#FFFFFF");
  await assertButtonContrast(dialog.getByRole("button", { name: "保存颜色", exact: true }));
  await dialog.screenshot({ path: join(out, "group-color-editor-dark.png") });
  await dialog.getByRole("button", { name: "保存颜色", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const id = (await api("accounts")).accounts.find((a: { group: string }) => a.group === "常用").id;
  const style = await page.locator(`[data-account-id="${id}"] .node-core`).evaluate((node) => ({ fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke, width: getComputedStyle(node).strokeWidth }));
  assert.equal(style.fill, "rgb(255, 255, 255)");
  assert.notEqual(style.stroke, "none");
  assert.ok(parseFloat(style.width) >= 1, "White/custom node must retain a visible outline");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("button", { name: "海蓝", exact: true }).isVisible(), true);
  assert.equal(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth), false, "Mobile colour editor must not overflow horizontally");
  const saveBox = await dialog.getByRole("button", { name: "保存颜色", exact: true }).boundingBox();
  assert.ok(saveBox && saveBox.y + saveBox.height <= 812, "Mobile save action must stay in view");
  await dialog.screenshot({ path: join(out, "group-color-editor-mobile-dark.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const model = (await api("accounts")).groupColors;
  await api("map/groups/color", "POST", { name: "常用", color: null, expectedRevision: model.revision });
  await page.setViewportSize(viewport);
  await page.reload();
  await page.locator("[data-node]").first().waitFor();
}

export async function verifyLoadingSkeleton(page: Page, origin: string, out: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/auth/session", async (route) => { await gate; await route.continue(); }, { times: 1 });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".workspace-loading .loading-composition").waitFor();
    assert.equal(await page.locator(".loading-square").count(), 3);
    assert.equal(await page.locator(".app-loading").count(), 0, "Obsolete duplicate loading screen must be removed");
    await page.screenshot({ path: join(out, "loading-skeleton.png"), fullPage: true });
  } finally { release(); }
}

export async function verifyReducedColorMotion(page: Page) {
  await page.getByRole("button", { name: "分组颜色", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分组颜色", exact: true });
  await dialog.getByRole("button", { name: "梅紫", exact: true }).click();
  const animated = await dialog.locator("svg").evaluateAll((svgs) => svgs.flatMap((svg) => [svg, ...svg.querySelectorAll("*")]).filter((node) => {
    const style = getComputedStyle(node);
    return style.animationName !== "none" || style.transitionDuration.split(",").some((time) => parseFloat(time) > 0);
  }).length);
  assert.equal(animated, 0, "Reduced/disabled motion must cover the new preview and colour swatches");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

/** A short recording of real interactions, using the same isolated fixture. */
export async function recordMotionShowcase(page: Page, origin: string, out: string) {
  const browser = page.context().browser()!;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, storageState: await page.context().storageState(),
    recordVideo: { dir: out, size: { width: 1440, height: 900 } },
  });
  const demo = await context.newPage(), errors: string[] = [];
  demo.on("pageerror", (e) => errors.push(e.message));
  const video = demo.video()!;
  try {
    await demo.goto(origin);
    await demo.locator("[data-node]").first().waitFor();
    await demo.waitForTimeout(800);
    await demo.getByRole("button", { name: "分组颜色", exact: true }).click();
    const dialog = demo.getByRole("dialog", { name: "分组颜色", exact: true });
    await dialog.waitFor();
    for (const name of ["梅紫", "群青", "赭黄", "青绿"]) {
      await dialog.getByRole("button", { name, exact: true }).hover();
      await dialog.getByRole("button", { name, exact: true }).click();
      await demo.waitForTimeout(650);
    }
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await demo.locator("[data-node]").first().click();
    await demo.waitForTimeout(600);
    await demo.getByRole("button", { name: "关闭账号详情" }).click();
    await demo.getByRole("button", { name: "列表视图" }).click();
    await demo.locator(".site-row").first().hover();
    await demo.waitForTimeout(650);
    await demo.getByRole("button", { name: "地图视图" }).click();
    await demo.waitForTimeout(700);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  await video.saveAs(join(out, "bauhaus-motion.webm"));
}
