import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

// Called only by the owned synthetic query-focus fixture after selecting an account.
export async function verifyWorkspaceFrames(page: Page, out: string) {
  const screenshots: string[] = [], geometry: unknown[] = [];
  const sizes = [
    { width: 1440, height: 960 }, { width: 1024, height: 700 },
    { width: 768, height: 960 }, { width: 1920, height: 1080 },
    { width: 375, height: 860 },
  ];
  try {
    for (const theme of ["light", "dark"]) {
      const change = page.getByRole("button", { name: theme === "dark" ? "切换到深色" : "切换到浅色", exact: true });
      if (await change.count()) await change.click();
      for (const size of sizes) {
        await page.setViewportSize(size);
        await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getTiming().iterations === Infinity || !["running", "pending"].includes(a.playState)));
        const measured = await page.evaluate(() => {
          const map = document.querySelector(".atlas-map")!, detail = document.querySelector(".account-detail")!;
          const m = map.getBoundingClientRect(), d = detail.getBoundingClientRect();
          return { viewport: innerWidth, theme: document.documentElement.dataset.theme,
            map: { top: m.top, bottom: m.bottom, height: m.height },
            detail: { top: d.top, bottom: d.bottom, height: d.height, position: getComputedStyle(detail).position, overflow: getComputedStyle(detail).overflowY },
            scrollWidth: document.body.scrollWidth };
        });
        geometry.push({ ...size, ...measured });
        const name = `${size.width}-${size.height}-${theme}-workspace-frames.png`;
        await page.screenshot({ path: join(out, name), fullPage: size.width > 760 }); screenshots.push(name);
        assert.ok(measured.scrollWidth <= size.width + 1, "Workspace must not overflow horizontally");
        if (size.width > 760) {
          assert.ok(Math.abs(measured.map.top - measured.detail.top) <= 1, "Map and detail top borders must align");
          assert.ok(Math.abs(measured.map.bottom - measured.detail.bottom) <= 1, "Map and detail bottom borders must align");
          assert.equal(measured.detail.overflow, "auto", "Detail content must scroll inside its aligned frame");
        } else {
          assert.equal(measured.detail.position, "fixed", "Mobile detail must keep its bottom sheet");
          assert.ok(measured.detail.height <= size.height * 0.65 + 1, "Mobile detail must leave room for the map");
        }
      }
    }
    const scroll = await page.locator(".account-detail").evaluate(e => {
      e.scrollTop = e.scrollHeight;
      return { reached: Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) <= 1 };
    });
    assert.equal(scroll.reached, true, "The last detail action must remain reachable");
    return { screenshots, geometry };
  } finally {
    writeFileSync(join(out, "workspace-frame-geometry.json"), JSON.stringify(geometry, null, 2));
    await page.setViewportSize({ width: 1440, height: 960 });
    const light = page.getByRole("button", { name: "切换到浅色", exact: true });
    if (await light.count()) await light.click();
  }
}
