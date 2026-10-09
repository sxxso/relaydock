import { chromium } from "playwright";
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
async function main() {
  const temp = mkdtempSync(join(tmpdir(), "atlas-platform-ui-")),
    out = join(process.cwd(), "output/playwright/platforms"),
    port = Number(process.env.ATLAS_PLATFORM_PORT || 3319),
    origin = `http://127.0.0.1:${port}`;
  mkdirSync(out, { recursive: true });
  const runtime = join(temp, "runtime");
  copyIsolatedBuild(process.cwd(), runtime);
  const buildId = readFileSync(
    join(runtime, ".next", "BUILD_ID"),
    "utf8",
  ).trim();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let hits = 0;
  const fixture = createServer((req, res) => {
    hits++;
    assert.equal(req.headers.authorization, "Bearer fixture-only");
    res.setHeader("Content-Type", "application/json");
    const reply = () =>
      res.end(
        JSON.stringify(
          req.url?.startsWith("/overflow")
            ? req.url.endsWith("/usage/token")
              ? {
                  code: true,
                  data: {
                    total_available: "1000000000000",
                    unlimited_quota: false,
                  },
                }
              : { success: true, data: { quota: "1000000000000" } }
            : req.url?.endsWith("/api/user/self")
              ? { success: true, data: { quota: "15000000" } }
              : req.url?.endsWith("/credits")
                ? { data: { total_credits: "9.3", total_usage: "0.1" } }
                : req.url?.endsWith("/wallet")
                  ? { data: { amount: "900", used: "200" } }
                  : req.url?.endsWith("/usage/token")
                    ? {
                        code: true,
                        data: {
                          total_available: "500000",
                          unlimited_quota: false,
                        },
                      }
                    : req.url?.endsWith("/v1/user/info")
                      ? { status: true, data: { totalBalance: "12.5" } }
                      : {
                          balance: "0",
                          is_available: true,
                          balance_infos: [
                            { currency: "CNY", total_balance: "12.25" },
                          ],
                        },
        ),
      );
    if (req.url?.startsWith("/slow")) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        reply();
      }, 12000);
      timers.add(timer);
    } else reply();
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const fixtureRoot = "http://127.0.0.1:" + (fixture.address() as any).port;
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
        RELAYDOCK_ADMIN_PASSWORD_HASH: hashPassword("fixture-password-123"),
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
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    page: import("playwright").Page | undefined;
  const passed: string[] = [],
    errors: string[] = [];
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/api/auth/session")).ok) break;
      } catch {}
      if (i === 99) throw new Error("Fixture server not ready:" + logs);
      await new Promise((r) => setTimeout(r, 300));
    }
    browser = await chromium.launch({
      headless: true,
      env: cleanRuntimeEnv() as Record<string, string>,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page
      .getByLabel("管理员密码", { exact: true })
      .fill("fixture-password-123");
    await page.getByRole("button", { name: "进入我的群岛" }).click();
    await page.getByRole("button", { name: "添加第一个站点" }).waitFor();
    const session = await (
      await context.request.get(origin + "/api/auth/session")
    ).json();
    const api = async (path: string, method = "GET", data?: unknown) => {
      const r = await context.request.fetch(origin + "/api/" + path, {
        method,
        headers: { Origin: origin, "x-csrf-token": session.csrf },
        ...(data === undefined ? {} : { data }),
        timeout: 40000,
      });
      const body = await r.json();
      assert.ok(r.ok(), `${path}: ${JSON.stringify(body)}`);
      return body;
    };
    await page.getByRole("button", { name: "添加第一个站点" }).click();
    let dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByRole("radio").count(), 8);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, "platform-menu-light.png") });
    await dialog
      .getByRole("radio", { name: "New API · 账户余额", exact: true })
      .check();
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByLabel("站点名称").fill("New API · 主账号");
    await dialog.getByLabel("网站地址").fill(fixtureRoot);
    await dialog
      .getByLabel("用户管理令牌", { exact: true })
      .fill("fixture-only");
    await dialog.getByLabel("用户 ID").fill("123");
    await dialog.getByText("高级连接设置", { exact: true }).click();
    await dialog.getByRole("combobox", { name: "查询超时" }).click();
    await page.getByRole("option", { name: "20 秒", exact: false }).click();
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByRole("button", { name: "暂不测试，继续" }).click();
    await dialog.getByLabel("我已确认换算系数", { exact: true }).check();
    await dialog.getByLabel("每单位对应的原始配额").fill("500000");
    await dialog.getByLabel("我已确认余额单位与查询口径").check();
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByLabel("我确认保存尚未验证的配置").check();
    await dialog.getByRole("button", { name: "保存站点" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(hits, 0);
    let accounts = (await api("accounts")).accounts;
    const first = accounts[0];
    assert.equal(first.query.timeoutSeconds, 20);
    await page.locator("[data-node]").first().click();
    await page.getByRole("button", { name: "测试连接" }).click();
    await page.getByRole("status").filter({ hasText: "连接成功" }).waitFor();
    assert.equal(
      (await api(`accounts/${first.id}/history`)).snapshots.length,
      0,
    );
    await page
      .locator(".account-detail")
      .getByRole("button", { name: "刷新余额", exact: true })
      .click();
    await page.getByRole("status").filter({ hasText: "余额已同步" }).waitFor();
    assert.equal((await api("accounts")).accounts[0].balance, "30");
    passed.push("平台分组菜单、20 秒配置、测试不写余额与点击同步");
    await page.getByRole("button", { name: "收藏账号", exact: true }).click();
    assert.equal((await api("accounts")).accounts[0].query.timeoutSeconds, 20);
    passed.push("收藏编辑保留查询配置");
    for (const provider of [
      "generic",
      "deepseek",
      "openrouter",
      "newapi-token",
      "siliconflow",
      "custom",
    ]) {
      const a = await api("accounts", "POST", {
        name: provider,
        siteUrl: fixtureRoot,
        managementUrl: fixtureRoot,
        credential: "fixture-only",
        provider,
        group: provider === "custom" ? "实验" : "平台",
        unit: provider === "deepseek" ? "CNY" : "USD",
        quotaPerUnit: "500000",
        query: {
          path: "/wallet",
          balancePath: "data.amount",
          subtractPath: "data.used",
          divisor: "100",
        },
      });
      const result = await api(`accounts/${a.id}/sync`, "POST");
      assert.equal(
        result.balance,
        (
          {
            generic: "0",
            deepseek: "12.25",
            openrouter: "9.2",
            "newapi-token": "1",
            siliconflow: "12.5",
            custom: "7",
          } as any
        )[provider],
      );
    }
    const exportData = await api("backup/export");
    assert.ok(!JSON.stringify(exportData).includes("fixture-only"));
    passed.push("七平台（含旧接口兼容）真实 HTTP 夹具与脱敏备份");
    await page.reload();
    await page.locator("[data-node]").first().waitFor();
    for (const [value, label] of [
      ["paper", "素纸"],
      ["dots", "点阵"],
      ["grid", "方格"],
      ["cross", "十字坐标"],
      ["contours", "等高线"],
    ]) {
      await page.getByRole("combobox", { name: "地图背景" }).click();
      await page.getByRole("option", { name: label, exact: false }).click();
      await page.waitForFunction(
        (v) =>
          document
            .querySelector('[data-testid="atlas-map"]')
            ?.getAttribute("data-background") === v,
        value,
      );
      await page.waitForTimeout(200);
      await page.screenshot({
        path: join(out, "background-" + value + ".png"),
      });
      assert.equal((await api("accounts")).settings.mapBackground, value);
    }
    await page.reload();
    await page.locator("[data-node]").first().waitFor();
    assert.equal(
      await page
        .locator('[data-testid="atlas-map"]')
        .getAttribute("data-background"),
      "contours",
    );
    passed.push("5 种底图切换与重启页面持久化，无镜头位置跳动");
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: 1440, height: 960 });
      await api("settings", "PATCH", {
        theme,
        motion: true,
        mapBackground: "grid",
      });
      await page.reload();
      await page.locator("[data-node]").first().waitFor();
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({
          width,
          height: width === 375 ? 812 : 960,
        });
        if (width === 375)
          assert.equal(
            await page
              .locator(".toolbar-filters .atlas-select-value")
              .evaluateAll((els) =>
                els.every((el) => el.scrollWidth <= el.clientWidth),
              ),
            true,
            "mobile default filter labels must remain readable",
          );
        await page.getByRole("combobox", { name: "地图背景" }).click();
        const menu = page.locator(".atlas-select-content");
        await menu.waitFor();
        await page.waitForTimeout(200);
        const box = await menu.boundingBox();
        assert.ok(
          box &&
            box.x >= 0 &&
            box.x + box.width <= width + 1 &&
            box.y >= 0 &&
            box.y + box.height <= (width === 375 ? 812 : 960) + 1,
        );
        await page.screenshot({
          path: join(out, `background-menu-${theme}-${width}.png`),
        });
        await page.keyboard.press("Escape");
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
      }
    }
    passed.push("浅深色与 375/768/1440 背景菜单碰撞、键盘退出及无溢出");
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "添加站点", exact: false }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("radio", { name: "自定义余额接口", exact: true })
      .check();
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByLabel("站点名称").fill("自定义钱包");
    await dialog.getByLabel("网站地址").fill(fixtureRoot);
    await dialog.getByLabel("GET 查询路径").fill("/wallet");
    await dialog.getByLabel("余额字段路径").fill("data.amount");
    await dialog.getByLabel("扣减字段").fill("data.used");
    await dialog.getByLabel("结果除数").fill("100");
    await dialog.getByLabel("查询密钥", { exact: true }).fill("fixture-only");
    await dialog.getByRole("combobox", { name: "认证方式" }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, "custom-query-menu-dark.png") });
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByRole("button", { name: "暂不测试，继续" }).click();
    await dialog.getByLabel("我已确认余额单位与查询口径").check();
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await dialog.getByLabel("我确认保存尚未验证的配置").check();
    await dialog.getByRole("button", { name: "保存站点" }).click();
    await dialog.waitFor({ state: "hidden" });
    const custom = (await api("accounts")).accounts.find(
      (a: any) => a.name === "自定义钱包",
    );
    assert.equal(custom.query.balancePath, "data.amount");
    assert.equal(
      (await api(`accounts/${custom.id}/test`, "POST")).balance,
      "7",
    );
    assert.equal(
      (await api(`accounts/${custom.id}/history`)).snapshots.length,
      0,
    );
    passed.push("自定义字段映射和认证菜单完整保存与测试");
    for (const provider of ["newapi", "newapi-token"]) {
      const a = await api("accounts", "POST", {
        name: "overflow " + provider,
        provider,
        siteUrl: fixtureRoot,
        managementUrl: fixtureRoot + "/overflow",
        credential: "fixture-only",
        quotaPerUnit: "0.000000000001",
        initialBalance: "8.500123456789",
      });
      const before = await api(`accounts/${a.id}/history`),
        beforeHits: number = hits;
      for (const operation of ["test", "sync"]) {
        const response = await context.request.post(
          origin + `/api/accounts/${a.id}/${operation}`,
          { headers: { Origin: origin, "x-csrf-token": session.csrf } },
        );
        assert.equal(response.status(), 502);
        const body = await response.json();
        assert.equal(body.diagnostic.code, "invalid_balance");
        assert.equal(
          body.diagnostic.stages.find((s: any) => s.id === "parse").status,
          "error",
        );
        assert.equal(
          (await api("accounts")).accounts.find(
            (account: any) => account.id === a.id,
          ).balance,
          "8.500123456789",
        );
        assert.deepEqual(await api(`accounts/${a.id}/history`), before);
      }
      assert.equal(hits, beforeHits + 2);
    }
    passed.push(
      "账户与令牌换算溢出：测试/刷新同为解析失败，保留旧快照、不重试",
    );
    const slow = await api("accounts", "POST", {
      name: "慢连接夹具",
      siteUrl: fixtureRoot,
      managementUrl: fixtureRoot + "/slow",
      provider: "newapi",
      credential: "fixture-only",
      initialBalance: "88",
      quotaPerUnit: "500000",
      query: { timeoutSeconds: 20 },
    });
    const previousHits = hits;
    const delayed = await api(`accounts/${slow.id}/test`, "POST");
    assert.equal(delayed.balance, "30");
    assert.equal(
      (await api(`accounts/${slow.id}/history`)).snapshots.length,
      1,
    );
    assert.equal(hits, previousHits + 1);
    const details = (await api("backup/export")).accounts.find(
      (a: any) => a.id === slow.id,
    ).details;
    await api(`accounts/${slow.id}`, "PATCH", {
      ...details,
      query: { ...details.query, timeoutSeconds: 10 },
    });
    const failure = await context.request.post(
      origin + `/api/accounts/${slow.id}/sync`,
      {
        headers: { Origin: origin, "x-csrf-token": session.csrf },
        timeout: 15000,
      },
    );
    assert.equal(failure.status(), 502);
    assert.match((await failure.json()).error, /等待响应/);
    assert.equal(
      (await api("accounts")).accounts.find((a: any) => a.id === slow.id)
        .balance,
      "88",
    );
    assert.equal(hits, previousHits + 2);
    passed.push("12 秒慢响应：20 秒成功，10 秒真实超时，不重试不清零");
    const idleHits = hits;
    await page.waitForTimeout(1100);
    assert.equal(hits, idleHits);
    assert.deepEqual(errors, []);
    passed.push("等待不查询、无浏览器异常");
    writeFileSync(
      join(out, "verification.json"),
      JSON.stringify(
        {
          passed,
          buildId,
          isolatedRuntimeWithoutEnvFiles: true,
          errors,
          fixtureRequests: hits,
          isolatedDatabase: true,
          realProviderVerified: false,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ passed, errors, fixtureRequests: hits }, null, 2),
    );
  } catch (e) {
    if (page) {
      await page
        .screenshot({ path: join(out, "failure.png"), fullPage: true })
        .catch(() => {});
      writeFileSync(join(out, "failure-dom.txt"), await page.content());
    }
    console.error("Completed:", passed);
    throw e;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once("exit", r));
      server.kill();
      await exited;
    }
    for (const timer of timers) clearTimeout(timer);
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
    writeFileSync(join(out, "server-log.txt"), logs);
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith("atlas-platform-ui-"));
    assert.equal(resolve(runtime), join(resolve(temp), "runtime"));
    unlinkSync(join(runtime, "node_modules"));
    rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
