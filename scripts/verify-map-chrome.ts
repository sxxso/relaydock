import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Page } from "playwright";

export async function verifyMapChrome(page: Page, out: string) {
  const choose = async (name: string) => {
    await page.getByRole("combobox", { name: "地图背景", exact: true }).click();
    await page.getByRole("option").filter({ has: page.getByText(name, { exact: true }) }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
  };
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "地图视图", exact: true }).click();
  await choose("等高线");
  await page.mouse.move(0, 0);
  await page.locator(".atlas-map").evaluate(async (map) => {
    await Promise.all(map.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const geometry = await page.locator(".atlas-map").evaluate((map) => {
    const wrapper = map.querySelector(".map-style-control")!;
    const trigger = wrapper.querySelector(".atlas-select-trigger")!;
    const mini = map.querySelector(".map-minimap")!;
    return {
      wrapperBorder: getComputedStyle(wrapper).borderTopWidth,
      triggerBorder: getComputedStyle(trigger).borderTopWidth,
      triggerRadius: getComputedStyle(trigger).borderTopLeftRadius,
      miniRadius: getComputedStyle(mini).borderTopLeftRadius,
      viewportOpacity: getComputedStyle(mini.querySelector(".minimap-viewport")!).fillOpacity,
      svgOverflow: getComputedStyle(mini.querySelector("svg")!).overflow,
    };
  });
  writeFileSync(join(out, "map-chrome-geometry.json"), JSON.stringify(geometry, null, 2));
  await page.locator(".atlas-map").screenshot({ path: join(out, "map-chrome-baseline.png") });
  assert.equal(geometry.wrapperBorder, "0px", "The background wrapper must not frame an already-framed select");
  assert.equal(geometry.triggerBorder, "2px", "One printed frame belongs on the background trigger");
  assert.ok(parseFloat(geometry.triggerRadius) <= 4, "Map chrome must not nest a pill inside a square frame");
  assert.ok(parseFloat(geometry.miniRadius) <= 4, "The overview uses the same small square corners");
  assert.ok(Number(geometry.viewportOpacity) <= 0.06, "The viewport tint must not obscure the group colors");
  assert.equal(geometry.svgOverflow, "hidden", "SVG paint must stay inside its overview surface");
  assert.match(await page.locator(".minimap-caption").innerText(), /大小不代表余额/);
  assert.equal(await page.locator(".map-caption").count(), 0, "Do not duplicate the overview legend outside its card");

  for (const theme of ["light", "dark"]) {
    if (theme === "dark") {
      await page.getByRole("button", { name: "切换到深色", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    }
    for (const size of [{ width: 1440, height: 960 }, { width: 768, height: 600 }, { width: 375, height: 700 }]) {
      await page.setViewportSize(size);
      // A resized/interrupted theme reveal can cancel or suspend an animation.
      // Observe current state with a bounded wait instead of keeping an old
      // finished promise alive indefinitely; keep repeating loaders out of it.
      await page.waitForFunction(() => document.getAnimations().every((animation) =>
        animation.effect?.getTiming().iterations === Infinity ||
        !["running", "pending"].includes(animation.playState)), undefined, { timeout: 3000 });
      const frame = await page.locator(".atlas-map").boundingBox();
      const trigger = await page.getByRole("combobox", { name: "地图背景", exact: true }).boundingBox();
      const move = await page.locator(".map-move-launcher").boundingBox();
      const mini = await page.locator(".map-minimap").boundingBox();
      assert.ok(frame && trigger && move && mini);
      assert.ok(Math.abs(trigger.x - move.x) < 1 && Math.abs(trigger.width - move.width) < 1,
        "Background and move controls must share a column and width");
      assert.ok(move.y >= trigger.y + trigger.height + 6, "Stacked controls need a deliberate gap");
      assert.ok(mini.x >= frame.x && mini.x + mini.width <= frame.x + frame.width && mini.y + mini.height <= frame.y + frame.height,
        "The overview must stay inside the map");
      const index = await page.locator(".map-group-index > summary").boundingBox();
      assert.ok(index && index.x + index.width <= trigger.x - 4, "Opposing corner controls must not collide on small screens");
      await page.locator(".atlas-map").screenshot({ path: join(out, `map-chrome-${theme}-${size.width}.png`) });
      if (size.width === 375) {
        await page.getByRole("button", { name: "定位小窗", exact: true }).click();
        await page.locator(".map-caption").waitFor({ state: "attached" });
        assert.equal(await page.locator(".map-caption").isVisible(), true, "Hiding the mobile overview must not hide the size disclaimer too");
        const caption = await page.locator(".map-caption").boundingBox();
        const controls = await page.locator(".map-controls").boundingBox();
        assert.ok(caption && controls && caption.x >= frame.x && caption.x + caption.width <= frame.x + frame.width,
          "The mobile fallback disclaimer must stay inside the map");
        assert.ok(caption.y + caption.height <= controls.y - 4, "The fallback disclaimer must not cover zoom controls");
        await page.locator(".atlas-map").screenshot({ path: join(out, `map-chrome-${theme}-375-no-overview.png`) });
        await page.getByRole("button", { name: "定位小窗", exact: true }).click();
      }
    }
  }
  await page.getByRole("button", { name: "切换到浅色", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.setViewportSize({ width: 1440, height: 960 });
  const trigger = page.getByRole("combobox", { name: "地图背景", exact: true });
  await trigger.focus();
  assert.ok(await trigger.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth) >= 2), "Removing the double frame must preserve keyboard focus");
  await trigger.press("Enter");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  assert.ok(await trigger.evaluate((el) => el === document.activeElement));
  await page.getByRole("button", { name: "定位小窗", exact: true }).click();
  assert.match(await page.locator(".map-caption").innerText(), /大小不代表余额/);
  await page.getByRole("button", { name: "定位小窗", exact: true }).click();
  await choose("点阵");
  const touch = await page.context().browser()!.newContext({ hasTouch: true, isMobile: true,
    viewport: { width: 375, height: 700 }, reducedMotion: "reduce" });
  try {
    await touch.addCookies(await page.context().cookies());
    const mobile = await touch.newPage();
    await mobile.goto(page.url());
    await mobile.getByRole("button", { name: "地图视图", exact: true }).click();
    await mobile.locator(".map-style-control").waitFor();
    for (const selector of [".map-style-control .atlas-select-trigger", ".map-move-launcher"]) {
      const bounds = await mobile.locator(selector).boundingBox();
      assert.ok(bounds && bounds.height >= 44, "Touch corner controls must keep a 44px target");
    }
    await mobile.locator(".atlas-map").screenshot({ path: join(out, "map-chrome-touch.png") });
  } finally { await touch.close(); }
}
