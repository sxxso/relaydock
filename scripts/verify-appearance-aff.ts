import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "playwright";
import type { Settings } from "../src/lib/validation";

// Called only inside the generated query-focus fixture. Never opens real data.
export async function verifyAppearance(page: Page, out: string, access: {
  read: () => Promise<Settings>; save: (value: Settings) => Promise<unknown>;
  select: (label: string, option: string) => Promise<void>;
}) {
  const original = await access.read(), screenshots: string[] = [], evidence: unknown[] = [];
  let release: (() => void) | undefined;
  const shot = async (name: string) => { await page.screenshot({ path: join(out, name) }); screenshots.push(name); };
  const reloadMap = async () => {
    await page.reload(); await page.getByTestId("atlas-map").waitFor();
    // SVG mounts before D3 finishes its initial fit. Compare density at the
    // settled camera, not at different points of that real transition.
    let previous = "", same = 0; const started = Date.now();
    while (Date.now() - started < 5000 && same < 8) {
      const value = await page.getByTestId("map-world").getAttribute("transform") || "";
      same = value && value === previous ? same + 1 : 0; previous = value;
      if (same < 8) await page.waitForTimeout(40);
    }
    assert.ok(same >= 8, "Initial map camera did not settle");
  };
  const settings = async () => { await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByRole("combobox", { name: "特效颜色", exact: true }).waitFor(); };
  const settle = async () => { await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="特效颜色"]')].some(e => !(e as HTMLButtonElement).disabled)); };
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await access.save({ ...original, motion: true }); await reloadMap(); await settings();
    await access.select("特效颜色", "海蓝"); await settle();
    const blue = await access.read(); assert.match(blue.inkColor || "", /^#[0-9a-f]{6}$/i);
    const danger = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--danger").trim());
    await access.select("特效颜色", "紫色"); await settle();
    const purple = await access.read(); assert.notEqual(purple.inkColor, blue.inkColor);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--danger").trim()), danger);
    await access.select("特效颜色", "自定义");
    // Native color inputs open an OS picker. Exercise their browser change
    // event without launching a platform dialog in the headless fixture.
    await page.getByLabel("自定义特效颜色", { exact: true }).evaluate((input, color) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, color);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, "#2468ac"); await settle();
    assert.equal((await access.read()).inkColor?.toLowerCase(), "#2468ac");
    await access.select("底图密度", "疏朗"); await settle(); assert.equal((await access.read()).mapDensity, "sparse");
    await page.getByRole("slider", { name: "特效浓度", exact: true }).press("Home"); await settle(); assert.equal((await access.read()).inkOpacity, 0);
    await page.getByRole("slider", { name: "底图浓度", exact: true }).press("Home"); await settle(); assert.equal((await access.read()).mapOpacity, 0);
    await shot("1440-light-appearance-controls.png"); await page.setViewportSize({ width: 375, height: 860 });
    await shot("375-light-appearance-controls.png"); assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 960 });
    await access.save({ ...purple, inkColor: "#2468ac", inkOpacity: 100, mapOpacity: 37, mapDensity: "dense", mapBackground: "sea", motion: true }); await reloadMap();
    const stored = await access.read(); assert.equal(stored.mapOpacity, 37); assert.equal(stored.mapDensity, "dense"); assert.equal(stored.inkColor, "#2468ac");
    const map = page.getByTestId("atlas-map");
    assert.equal(await map.locator(".map-pattern-plane").getAttribute("opacity"), "0.37");
    const spacing = async () => { await page.waitForFunction(() => Number(document.querySelector('.atlas-map')?.getAttribute('data-grid-spacing')) > 0); return Number(await map.getAttribute("data-grid-spacing")); };
    const denseSpacing = await spacing();
    const camera = await map.getByTestId("map-world").getAttribute("transform");
    for (const [density, factor] of [["standard", 2], ["sparse", 4]] as const) {
      await access.save({ ...stored, mapDensity: density }); await reloadMap();
      const measured = await spacing();
      assert.equal(await map.getByTestId("map-world").getAttribute("transform"), camera);
      assert.ok(Math.abs(measured - denseSpacing * factor) <= 0.05, "Density must change the rendered pattern spacing");
      evidence.push({ density, spacing: measured, opacity: await map.locator(".map-pattern-plane").getAttribute("opacity") });
    }
    const point = await map.evaluate(e => {
      const r = e.getBoundingClientRect();
      for (let y = 80; y < r.height - 80; y += 60) for (let x = 60; x < r.width - 60; x += 60) {
        const hit = document.elementFromPoint(r.left + x, r.top + y);
        if (hit && e.contains(hit) && hit.closest("svg.atlas-svg") && !hit.closest("button,a,input,[data-node]")) return { x: r.left + x, y: r.top + y };
      }
      throw new Error("No blank SVG point available");
    });
    await page.mouse.move(point.x, point.y); await page.mouse.move(point.x + 3, point.y + 3);
    await page.waitForFunction(() => {
      const el = document.querySelector<HTMLCanvasElement>(".ink-canvas"); if (!el) return false;
      const p = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
      for (let i = 3; i < p.length; i += 4) if (p[i] >= 5 && Math.abs(p[i - 3] - 36) < 16 && Math.abs(p[i - 2] - 104) < 16 && Math.abs(p[i - 1] - 172) < 16) return true;
      return false;
    }, undefined, { timeout: 5000 });
    await shot("1440-custom-blue-ink.png");
    for (const theme of ["light", "dark"] as const) for (const background of ["sea", "contours", "grid"] as const) {
      await access.save({ ...stored, theme, mapBackground: background, mapOpacity: 70, mapDensity: "sparse" }); await reloadMap();
      assert.equal(await map.getAttribute("data-background"), background);
      const pattern = await map.locator("pattern").first().evaluate(e => ({ width: e.getAttribute("width"), height: e.getAttribute("height"), transform: e.getAttribute("patternTransform"), paths: e.querySelectorAll("path").length }));
      assert.ok(Number(pattern.width) > 0 && Number(pattern.height) > 0); evidence.push({ theme, background, pattern });
      await shot(`1440-${theme}-${background}-background.png`);
    }
    await access.save({ ...stored, theme: "light", motion: true });
    const gate = new Promise<void>(r => { release = r; });
    const hold = async (route: Route) => { await gate; await route.continue(); };
    await page.route(/\/api\/accounts$/, hold);
    try {
      await page.reload({ waitUntil: "domcontentloaded" }); await page.locator(".workspace-loading").waitFor();
      await page.waitForFunction(() => document.querySelector(".loading-square-main")?.getAnimations().length);
      const shapes: string[] = [];
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        await page.locator(".loading-square").evaluateAll((elements, p) => {
          for (const e of elements) for (const a of e.getAnimations()) {
            a.pause(); a.currentTime = Number(a.effect!.getTiming().duration) * p;
          }
        }, phase);
        shapes.push(await page.locator(".loading-square-main").evaluate((e, p) => {
          for (const a of e.getAnimations()) { a.pause(); a.currentTime = Number(a.effect!.getTiming().duration) * p; }
          const s = getComputedStyle(e); return JSON.stringify({ transform: s.transform, radius: s.borderRadius, clip: s.clipPath });
        }, phase));
        const satellites = await page.locator(".loading-square-accent,.loading-square-warm").evaluateAll(elements => {
          const values: number[] = []; for (const e of elements) values.push(Number(getComputedStyle(e).opacity)); return values;
        });
        if (phase === 0 || phase === 0.75) assert.deepEqual(satellites, [phase === 0 ? 0 : 1, phase === 0 ? 0 : 1]);
        evidence.push({ loadingPhase: phase, satelliteOpacity: satellites });
        await shot(`1440-geometric-loader-${phase}.png`);
      }
      assert.ok(new Set(shapes).size >= 3, "Real loader must change geometry"); evidence.push({ loadingShapes: shapes });
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await page.locator(".loading-square-main").evaluate(e => getComputedStyle(e).animationName), "none");
    } finally { release?.(); release = undefined; await map.waitFor(); await page.unroute(/\/api\/accounts$/, hold); }
    await map.waitFor(); await settings(); await page.getByRole("button", { name: "恢复特效默认设置", exact: true }).click(); await settle();
    const reset = await access.read(); assert.equal(reset.inkColor, null); assert.equal(reset.inkOpacity, 100);
    return { screenshots, evidence, persisted: true, alertColorUnchanged: true, canvasPixelsMatched: true, reducedMotionStatic: true };
  } finally {
    release?.(); writeFileSync(join(out, "appearance-evidence.json"), JSON.stringify(evidence, null, 2));
    await access.save(original); await page.emulateMedia({ reducedMotion: "reduce" }); await page.setViewportSize({ width: 1440, height: 960 }); await reloadMap();
  }
}
