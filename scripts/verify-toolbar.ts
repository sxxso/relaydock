import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Account } from "../src/lib/validation";

type Api = (path: string, method?: string, data?: unknown) => Promise<any>;
const choose = async (page: Page, label: string, option: string) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option").filter({ has: page.getByText(option, { exact: true }) }).click();
  await page.getByRole("listbox").waitFor({ state: "hidden" });
};
async function withinViewport(page: Page, selector: string) {
  await page.locator(selector).waitFor();
  const rect = await page.locator(selector).boundingBox();
  assert.ok(rect && rect.width > 0 && rect.height > 0, `${selector} must be visible`);
  const size = page.viewportSize()!;
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= size.width + 1 && rect.y + rect.height <= size.height + 1,
    `${selector} clipped: ${JSON.stringify(rect)} in ${JSON.stringify(size)}`);
}
async function settleSelect(page: Page) {
  await page.locator('.atlas-select-content[data-state="open"]').waitFor();
  await page.waitForFunction(() => {
    const menu = document.querySelector(".atlas-select-content");
    return menu && parseFloat(getComputedStyle(menu).getPropertyValue("--radix-select-content-available-height")) > 0;
  });
  await page.locator(".atlas-select-content").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  // Popper placement and Radix's conditional scroll buttons settle separately
  // from the opening animation, especially under a busy CI/browser process.
  await page.waitForFunction(() => {
    const viewport = document.querySelector<HTMLElement>('.atlas-select-content[data-state="open"] .atlas-select-viewport');
    return viewport && viewport.clientHeight >= 44;
  }, undefined, { timeout: 2000 });
}
async function highlightedChoiceVisible(page: Page) {
  await withinViewport(page, ".atlas-select-item[data-highlighted]");
  const bounds = await page.locator(".atlas-select-viewport").evaluate((viewport) => {
    const item = viewport.querySelector(".atlas-select-item[data-highlighted]")!;
    return { viewport: viewport.getBoundingClientRect().toJSON(), item: item.getBoundingClientRect().toJSON() };
  });
  assert.ok(bounds.item.top >= bounds.viewport.top - 1 && bounds.item.bottom <= bounds.viewport.bottom + 1,
    `The focused choice must be visible inside the actual scroll area: ${JSON.stringify(bounds)}`);
}

export async function verifyToolbarMenus(page: Page, api: Api, out: string) {
  const fixtures: Account[] = [];
  try {
    for (let i = 0; i < 36; i++) fixtures.push(await api("accounts", "POST", {
      name: `菜单测试站点 ${i}`, siteUrl: "https://menu.fixture.invalid", group: `菜单分组 ${String(i).padStart(2, "0")}`, provider: "custom",
    }));
    await page.reload(); await page.locator("[data-node]").first().waitFor();
    await page.setViewportSize({ width: 768, height: 240 });
    await page.getByRole("combobox", { name: "筛选分组", exact: true }).click();
    await page.keyboard.press("Escape");
    for (let attempt = 0; attempt < 3; attempt++) {
      await choose(page, "筛选分组", "菜单分组 18");
      await page.getByRole("combobox", { name: "筛选分组", exact: true }).evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.getByRole("combobox", { name: "筛选分组", exact: true }).click();
      try { await settleSelect(page); }
      catch (error) {
        console.log("Short menu settle failure:", await page.evaluate(String.raw`(() => {
          return [...document.querySelectorAll('.atlas-select-content, .atlas-select-content > *, .atlas-select-trigger[data-state="open"]')].map(element => {
            const style = getComputedStyle(element);
            return {className:element.className, bounds:element.getBoundingClientRect().toJSON(), clientHeight:element.clientHeight,
              height:style.height, maxHeight:style.maxHeight, minHeight:style.minHeight, flex:style.flex,
              available:style.getPropertyValue('--radix-select-content-available-height'), side:element.getAttribute('data-side')};
          });
        })()`));
        await page.screenshot({ path: join(out, "toolbar-short-menu-failure.png") });
        throw error;
      }
      await withinViewport(page, ".atlas-select-content");
      const shortViewport = await page.locator(".atlas-select-viewport").boundingBox();
      if (!shortViewport || shortViewport.height < 44) {
        console.log("Short menu geometry:", await page.locator(".atlas-select-content").evaluate((menu) => {
          return [menu, ...Array.from(menu.children), document.querySelector('.atlas-select-trigger[data-state="open"]')!].map((element) => {
            const style = getComputedStyle(element);
            return { class: element.className, bounds: element.getBoundingClientRect().toJSON(),
              height: style.height, maxHeight: style.maxHeight, minHeight: style.minHeight, flex: style.flex,
              available: style.getPropertyValue("--radix-select-content-available-height"), side: element.getAttribute("data-side") };
          });
        }));
        await page.screenshot({ path: join(out, "toolbar-short-menu-failure.png") });
      }
      assert.ok(shortViewport && shortViewport.height >= 44, `A short menu must show a full usable option, got ${JSON.stringify(shortViewport)}`);
      await page.keyboard.press("End");
      await page.waitForFunction(() => document.querySelector('.atlas-select-item[data-highlighted] .atlas-select-label')?.textContent === "菜单分组 35");
      await highlightedChoiceVisible(page);
      await page.screenshot({ path: join(out, "toolbar-short-menu.png") });
      await page.keyboard.press("Enter");
    }
    await choose(page, "筛选分组", "所有分组");
    for (const size of [{ width: 1440, height: 720 }, { width: 768, height: 360 }, { width: 375, height: 500 }]) {
      await page.setViewportSize(size);
      await page.getByRole("combobox", { name: "筛选分组", exact: true }).click();
      await settleSelect(page);
      await withinViewport(page, ".atlas-select-content");
      const viewport = await page.locator(".atlas-select-viewport").boundingBox();
      assert.ok(viewport && viewport.height >= 44, "A long menu must leave room for actual choices, not only its header");
      await page.keyboard.press("End");
      await page.waitForFunction(() => document.querySelector('.atlas-select-item[data-highlighted] .atlas-select-label')?.textContent === "菜单分组 35");
      await highlightedChoiceVisible(page);
      await page.screenshot({ path: join(out, `toolbar-group-open-${size.width}.png`) });
      await page.keyboard.press("Enter");
      assert.match(await page.getByRole("combobox", { name: "筛选分组", exact: true }).innerText(), /菜单分组 35/);
      await choose(page, "筛选分组", "所有分组");
      await page.locator(".filter-menu > summary").click();
      await withinViewport(page, ".filter-menu > div");
      for (const [label, option] of [["档案范围", "所有档案"], ["记录时间", "超过七天未记录"], ["排序", "收藏优先"]]) {
        await page.getByRole("combobox", { name: label, exact: true }).click();
        await settleSelect(page);
        await withinViewport(page, ".atlas-select-content");
        if (label === "档案范围") await page.screenshot({ path: join(out, `toolbar-nested-open-${size.width}.png`) });
        await page.keyboard.press("Escape");
        await page.getByRole("listbox").waitFor({ state: "hidden" });
        assert.ok(await page.locator(".filter-menu").evaluate((el) => (el as HTMLDetailsElement).open), "Escape must dismiss the nested select before its parent filter menu");
        await choose(page, label, option);
        assert.ok(await page.locator(".filter-menu").evaluate((el) => (el as HTMLDetailsElement).open), "Picking a portal option must not close its parent filter menu");
      }
      await page.screenshot({ path: join(out, `toolbar-menu-${size.width}.png`) });
      await choose(page, "档案范围", "使用中的账号");
      await choose(page, "记录时间", "不限记录时间");
      await choose(page, "排序", "名称");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".filter-menu").evaluate((el) => (el as HTMLDetailsElement).open), false);
      assert.equal(await page.locator(".filter-menu > summary").evaluate((el) => el === document.activeElement), true);
    }
  } finally {
    for (const fixture of fixtures) await api(`accounts/${fixture.id}`, "DELETE");
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload(); await page.locator("[data-node]").first().waitFor();
  }
}

export async function verifyUndoRecovery(page: Page, api: Api, out: string) {
  const original: Account = (await api("accounts")).accounts.find((account: Account) => !account.archived);
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  const row = page.locator(`.site-row[data-site-row="${original.id}"]`);
  // Pick by row-relative button label; no account/query data outside this fixture.
  await row.getByRole("button", { name: `查看 ${original.name}`, exact: true }).click();
  const star = page.locator(".account-detail").getByRole("button", { name: original.favorite ? "取消收藏" : "收藏账号", exact: true });
  await star.click();
  await page.getByRole("button", { name: "撤销", exact: true }).waitFor();
  await page.getByRole("button", { name: "保存当前视图", exact: true }).click();
  const viewDialog = page.getByRole("dialog");
  await viewDialog.waitFor();
  await page.waitForTimeout(6500);
  assert.equal(await page.locator(".undo-notice").count(), 0, "Undo stays out of the way while a blocking dialog is open");
  await viewDialog.getByLabel("视图名称", { exact: true }).fill("撤销测试视图");
  await viewDialog.getByRole("button", { name: "保存视图", exact: true }).click();
  await viewDialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 1, "Reading a blocking dialog and its unrelated saved-view notice must not expire or erase the pending account undo");
  await page.route("**/api/accounts/undo", (route) => route.fulfill({ status: 503, json: { error: "撤销请求暂时失败" } }), { times: 1 });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByText("撤销请求暂时失败", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 1, "A failed undo must keep a retry action");
  assert.equal((await api("accounts")).accounts.find((a: Account) => a.id === original.id).favorite, !original.favorite);
  await page.getByRole("button", { name: "撤销", exact: true }).focus();
  await page.waitForTimeout(6500);
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 1, "Keyboard focus must pause expiry while reading a retry notice");
  await page.screenshot({ path: join(out, "undo-retry.png") });
  await page.setViewportSize({ width: 375, height: 500 });
  await page.locator(".account-detail").evaluate(async (detail) => {
    await Promise.all(detail.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})));
  });
  await withinViewport(page, ".undo-notice");
  await page.screenshot({ path: join(out, "undo-retry-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByText("已撤销", { exact: true }).waitFor();
  assert.equal((await api("accounts")).accounts.find((a: Account) => a.id === original.id).favorite, original.favorite);
  // A delayed canonical undo response must not overwrite a later favorite
  // operation on another account or discard its newer undo notice.
  await page.locator(".account-detail").getByRole("button", { name: /^(收藏账号|取消收藏)$/ }).click();
  let captured!: () => void, release!: () => void, finished!: () => void;
  const fetched = new Promise<void>((resolve) => { captured = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const handled = new Promise<void>((resolve) => { finished = resolve; });
  await page.route("**/api/accounts/undo", async (route) => {
    try { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); }
    finally { finished(); }
  }, { times: 1 });
  try {
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await fetched;
    assert.equal(await page.getByRole("button", { name: "正在撤销", exact: true }).isDisabled(), true);
    await page.waitForTimeout(6500);
    assert.equal(await page.locator(".undo-notice").count(), 1, "A pending request must not expire its notice");
    const next: Account = (await api("accounts")).accounts.find((a: Account) => !a.archived && a.id !== original.id);
    await page.locator(`.site-row[data-site-row="${next.id}"]`).getByRole("button", { name: `查看 ${next.name}`, exact: true }).click();
    await page.locator(".account-detail").getByRole("button", { name: /^(收藏账号|取消收藏)$/ }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).waitFor();
    await page.getByRole("button", { name: "撤销", exact: true }).focus();
    release(); await handled;
    await page.getByText("已撤销", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 1, "An older completion must not clear the newer account action");
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 1, "Closing an ordinary message must not dismiss undo");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByText("已撤销", { exact: true }).waitFor();
    assert.equal((await api("accounts")).accounts.find((a: Account) => a.id === next.id).favorite, next.favorite);
  } finally { release(); await handled; await page.unrouteAll({ behavior: "wait" }); }
  const model = await api("accounts");
  for (const view of model.savedViews.filter((v: {name: string}) => v.name === "撤销测试视图")) await api(`views/${view.id}`, "DELETE");
  await page.reload(); await page.locator("[data-node]").first().waitFor();
}
