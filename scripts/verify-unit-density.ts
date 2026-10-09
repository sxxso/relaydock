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
import { chromium, type Browser, type Page } from "playwright";
import { hashPassword } from "../src/lib/crypto";
import { Store } from "../src/lib/store";
import type { Account } from "../src/lib/validation";
import { cleanRuntimeEnv, copyIsolatedBuild } from "./isolated-runtime";

// Only a copied build, synthetic accounts and a temporary DB. No real env/data.
async function main() {
  const root = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "atlas-unit-density-"));
  const runtime = join(temp, "runtime"),
    key = Buffer.alloc(32, 7);
  const password = "fixture-unit-density-password",
    mode = process.argv[2] || "all";
  const out = join(
    root,
    "output",
    "playwright",
    "unit-density",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(out, { recursive: true });
  const passed: string[] = [],
    errors: string[] = [],
    metrics: unknown[] = [];
  let browser: Browser | undefined,
    server: ReturnType<typeof spawn> | undefined;
  let failure: unknown,
    logs = "",
    externalQueries = 0,
    buildId = "";
  const fixtures: Account[] = [];
  try {
    const store = new Store(join(temp, "atlas.sqlite"), key);
    try {
      store.setMeta("adminHash", hashPassword(password));
      const create = (name: string, patch = {}) =>
        store.create({
          name,
          siteUrl: "https://fixture.invalid",
          initialBalance: "12.34",
          ...patch,
        });
      fixtures.push(create("松岛 Alpha"));
      fixtures.push(create("自定义额度", { unit: "算力点" }));
      fixtures.push(
        create("OpenRouter", { provider: "openrouter", unit: "USD" }),
      );
      fixtures.push(
        create("SiliconFlow", { provider: "siliconflow", unit: "CNY" }),
      );
      fixtures.push(create("DeepSeek", { provider: "deepseek", unit: "USD" }));
      fixtures.push(
        create("New API Token", { provider: "newapi-token", unit: "USD" }),
      );
      fixtures.push(
        create(
          "长名称用于确认工作台拓宽之后完整显示并且没有遮挡或省略站点名称的每一个字符",
          { alias: "同站多账户", group: "常用" },
        ),
      );
      fixtures.push(
        create("DeepSeek 旧单位", { provider: "deepseek", unit: "算力点" }),
      );
      for (let i = 0; i < 20; i++)
        fixtures.push(
          create(`站点 ${String(i).padStart(2, "0")}`, {
            group: i % 2 ? "常用" : "备用",
          }),
        );
    } finally {
      store.close();
    }
    const port = await new Promise<number>((done, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => done(p));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
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
          RELAYDOCK_ADMIN_PASSWORD_HASH: hashPassword(password),
          RELAYDOCK_PUBLIC_URL: origin,
          RELAYDOCK_DNS_MODE: "system",
          RELAYDOCK_PRIVATE_HOSTS: "",
        },
      },
    );
    server.stdout!.on("data", (b) => (logs += String(b)));
    server.stderr!.on("data", (b) => (logs += String(b)));
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(origin + "/api/auth/session")).ok) break;
      } catch {}
      assert.ok(i < 100 && server.exitCode === null, "isolated server startup");
      await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.launch({ headless: true, env: cleanRuntimeEnv() });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (/\/api\/.*\/(sync|test)$/.test(url.pathname)) externalQueries++;
      if (url.hostname !== "127.0.0.1") errors.push("external browser request");
    });
    await page.goto(origin);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "进入我的群岛" }).click();
    await page.getByRole("button", { name: "列表视图" }).click();
    await page.locator(".site-row").first().waitFor();
    const list = async (): Promise<Account[]> =>
      (await (await context.request.get(origin + "/api/accounts")).json())
        .accounts;
    async function edit(account: Account) {
      if (await page.getByRole("button", { name: "关闭账号详情" }).count())
        await page.getByRole("button", { name: "关闭账号详情" }).click();
      await page
        .locator(".site-row")
        .filter({
          has: page.getByText(account.name, { exact: true }),
        })
        .locator(".site-identity")
        .click();
      await page.getByRole("button", { name: "编辑档案", exact: true }).click();
      return page.getByRole("dialog", { name: "编辑站点档案" });
    }
    async function save() {
      await page.getByRole("button", { name: "保存站点", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    const option = (label: string) =>
      page.getByRole("option", { name: new RegExp("^" + label) });
    if (mode !== "layout") {
      let dialog = await edit(fixtures[0]);
      assert.equal(
        await dialog
          .getByRole("combobox", { name: "余额单位", exact: true })
          .count(),
        1,
        "编辑余额单位必须是真正下拉框，不是文本建议列表",
      );
      assert.equal(
        await dialog
          .getByRole("combobox", { name: "余额单位", exact: true })
          .evaluate((el) => el.tagName),
        "BUTTON",
        "不能用 datalist 文本输入充当下拉选择",
      );
      await dialog
        .getByRole("combobox", { name: "余额单位", exact: true })
        .click();
      await page.getByRole("option").first().waitFor();
      for (const label of ["USD", "CNY", "积分", "自定义"])
        assert.equal(await option(label).count(), 1);
      await page.screenshot({ path: join(out, "unit-menu.png") });
      await option("CNY").click();
      await save();
      let saved = (await list()).find((a) => a.id === fixtures[0].id)!;
      assert.equal(saved.unit, "CNY");
      assert.equal(saved.balanceUnit, "USD");
      assert.equal(saved.balance, "12.34");
      assert.equal(saved.lastSnapshotAt, fixtures[0].lastSnapshotAt);
      assert.equal(saved.balanceSnapshotId, fixtures[0].balanceSnapshotId);
      passed.push("预设下拉保存；单位修改不转换旧余额");
      dialog = await edit(saved);
      assert.match(
        await dialog.getByRole("combobox", { name: "余额单位" }).innerText(),
        /CNY/,
      );
      await dialog.getByRole("combobox", { name: "余额单位" }).focus();
      await page.keyboard.press("Space");
      await page.getByRole("listbox").waitFor();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("role") === "option",
      );
      await page.keyboard.press("End");
      await page.waitForFunction(() =>
        document.activeElement?.textContent?.includes("自定义单位"),
      );
      await page.keyboard.press("Enter");
      const custom = dialog.getByLabel("自定义单位", { exact: true });
      await custom.fill("USD");
      assert.equal(await custom.count(), 1, "自定义输入预设同名文本时不得消失");
      await custom.fill("调用次数");
      await page.screenshot({ path: join(out, "edit-custom.png") });
      await save();
      saved = (await list()).find((a) => a.id === fixtures[0].id)!;
      assert.equal(saved.unit, "调用次数");
      dialog = await edit(saved);
      assert.equal(
        await dialog.getByLabel("自定义单位", { exact: true }).inputValue(),
        "调用次数",
      );
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      passed.push("键盘选择、自定义编辑与重新打开持久化");
      dialog = await edit(fixtures[1]);
      assert.equal(
        await dialog.getByLabel("自定义单位", { exact: true }).inputValue(),
        "算力点",
      );
      await dialog.getByRole("combobox", { name: "余额单位" }).click();
      await option("积分").click();
      assert.equal(
        await dialog.getByLabel("自定义单位", { exact: true }).count(),
        0,
      );
      await save();
      assert.equal(
        (await list()).find((a) => a.id === fixtures[1].id)!.unit,
        "积分",
      );
      passed.push("保留已有自定义单位，积分直接选择无需输入");
      for (const account of fixtures.slice(2, 6)) {
        dialog = await edit(account);
        const select = dialog.getByRole("combobox", { name: "余额单位" });
        if (["openrouter", "siliconflow"].includes(account.provider)) {
          assert.equal(await select.isDisabled(), true);
          await save();
          assert.equal(
            (await list()).find((a) => a.id === account.id)!.unit,
            account.unit,
          );
        } else {
          await select.click();
          assert.equal(await page.getByRole("option").count(), 2);
          await option("CNY").click();
          await save();
          assert.equal(
            (await list()).find((a) => a.id === account.id)!.unit,
            "CNY",
          );
        }
      }
      passed.push("固定平台/币种限制与添加向导一致");
      dialog = await edit(fixtures[7]);
      assert.equal(
        await dialog.locator('input[name="unit"]').count(),
        1,
        "旧版单位必须保留在表单数据中",
      );
      assert.equal(
        await dialog.locator('input[name="unit"]').inputValue(),
        "算力点",
        "旧版允许的自定义单位不能因控件重构丢失并默认成USD",
      );
      await dialog.getByLabel("账号别名").fill("只改别名");
      await save();
      saved = (await list()).find((a) => a.id === fixtures[7].id)!;
      assert.equal(saved.unit, "算力点");
      assert.equal(saved.balanceUnit, "算力点");
      dialog = await edit(saved);
      await dialog.getByRole("combobox", { name: "余额单位" }).click();
      await option("CNY").click();
      await save();
      saved = (await list()).find((a) => a.id === fixtures[7].id)!;
      assert.equal(saved.unit, "CNY");
      assert.equal(saved.balanceUnit, "算力点");
      passed.push("旧版不兼容单位保留，用户明确选择后才修改档案单位");
    }
    if (await page.getByRole("button", { name: "关闭账号详情" }).count())
      await page.getByRole("button", { name: "关闭账号详情" }).click();
    if (mode !== "units") {
      await page.locator(".toast").waitFor({ state: "hidden", timeout: 10000 });
      for (const width of [1920, 1440, 768, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => window.scrollTo(0, 0));
        for (const theme of ["light", "dark"]) {
          await page.evaluate(
            (t) => (document.documentElement.dataset.theme = t),
            theme,
          );
          const measured = await measure(page);
          metrics.push({ width, theme, ...measured });
          assert.equal(measured.overflow, false, "页面不得横向溢出");
          assert.equal(measured.scrollY, 0, "首屏密度必须从页首测量");
          if (width >= 1440) {
            assert.ok(
              measured.left <= 28 && measured.right <= 28,
              "桌面两侧留白应不超过28px",
            );
            assert.ok(measured.rowHeight <= 78, "普通列表行应紧凑且不超过78px");
            assert.ok(measured.fullRows >= 7, "900px视口首屏至少7个完整站点");
          }
          await page.screenshot({
            path: join(out, `list-${theme}-${width}.png`),
          });
        }
      }
      passed.push("375/768/1440/1920浅深主题、长名称无溢出，桌面密度测量");
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page
          .getByLabel("搜索站点", { exact: true })
          .fill(fixtures[6].name);
        await page.waitForFunction(
          () => document.querySelectorAll(".site-row").length === 1,
        );
        await page.locator(".site-identity").click();
        await page.locator(".account-detail").waitFor();
        assert.equal(
          await page.locator(".account-detail h2").innerText(),
          fixtures[6].name,
        );
        assert.equal((await measure(page)).overflow, false);
        await page.screenshot({
          path: join(out, `long-detail-dark-${width}.png`),
        });
        await page.getByRole("button", { name: "关闭账号详情" }).click();
      }
      await page.getByLabel("搜索站点", { exact: true }).fill("");
      await page.getByRole("button", { name: "批量管理", exact: true }).click();
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.equal((await measure(page)).overflow, false);
        await page.screenshot({ path: join(out, `batch-dark-${width}.png`) });
      }
      await page
        .getByRole("button", { name: "退出批量管理", exact: true })
        .click();
      passed.push("长名称完整显示、详情与批量模式在桌面/平板/手机均可操作");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("button", { name: "地图视图" }).click();
      await page.getByTestId("atlas-map").waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".ink-island")].every((el) =>
          el.getAnimations().every((a) => a.playState === "finished"),
        ),
      );
      await page.screenshot({ path: join(out, "map-dark-1440.png") });
      passed.push("拓宽后的地图可显示");
    }
    assert.equal(externalQueries, 0);
    assert.deepEqual(errors, []);
    passed.push("编辑/导航零查询、零浏览器错误");
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
    // Verify ownership and remove the node_modules junction before recursive cleanup.
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + sep));
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
          mode,
          buildId,
          isolated: true,
          passed,
          metrics,
          externalQueries,
          errors,
          failure: failure instanceof Error ? failure.message : null,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ out, passed, metrics, externalQueries, errors }),
    );
  }
  if (failure) throw failure;
}
async function measure(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector(".sites-page")!.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".site-row")].map((e) =>
      e.getBoundingClientRect(),
    );
    return {
      scrollY,
      left: r.left,
      right: innerWidth - r.right,
      rowHeight: Math.min(...rows.map((r) => r.height)),
      fullRows: rows.filter((r) => r.top >= 0 && r.bottom <= innerHeight)
        .length,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
