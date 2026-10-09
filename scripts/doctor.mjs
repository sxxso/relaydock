#!/usr/bin/env node
import { statSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { checkNodeVersion, doctorReport, runDoctor } from "./doctor-lib.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const development = args.includes("--development");
function failure(id, code, message, advice) {
  return doctorReport([{ id, status: "FAIL", code, message, advice }]);
}
function output(report) {
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`Atlas 本地部署自检 · ${development ? "development" : "production"} · ${report.status}`);
    for (const item of report.checks) {
      console.log(`[${item.status}] ${item.message} (${item.code})`);
      if (item.advice) console.log(`  建议：${item.advice}`);
    }
    console.log(`结果：${report.status}；退出码：${report.exitCode}（0=全部通过，1=有警告，2=有失败）`);
    console.log("仅本地检查；未访问外站、未输出秘密、未初始化或修复数据。");
  }
  process.exitCode = report.exitCode;
}
async function main() {
  if (args.some((arg) => !["--json", "--development", "--help"].includes(arg)) || new Set(args).size !== args.length) {
    output(failure("cli", "CLI_ARGUMENT_INVALID", "命令参数无效", "仅支持 --json、--development、--help；未知参数不会回显。"));
    return;
  }
  if (args.includes("--help")) {
    console.log("用法：npm run doctor -- [--json] [--development]\n默认检查 production 配置；--development 检查开发配置。\nJSON：npm run --silent doctor -- --json\n退出码：0=PASS，1=WARN，2=FAIL。仅本地检查，不输出配置值或修复数据。");
    return;
  }
  if (!checkNodeVersion(process.versions.node)) {
    output(await runDoctor({ nodeVersion: process.versions.node }));
    return;
  }
  const cwd = process.cwd(), mode = development ? "development" : "production";
  try {
    // Match Next's documented precedence and variable expansion, but never emit
    // loader logs (errors can contain private paths or configuration values).
    for (const name of [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"]) {
      try {
        const file = resolve(cwd, name), stat = statSync(file);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
        accessSync(file, constants.R_OK);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    process.env.NODE_ENV = mode;
    let errors = false;
    const { default: nextEnv } = await import("@next/env");
    const { combinedEnv } = nextEnv.loadEnvConfig(cwd, development, { info() {}, error() { errors = true; } }, true);
    if (errors) throw new Error();
    output(await runDoctor({ cwd, env: combinedEnv }));
  } catch {
    output(failure("environment", "ENVIRONMENT_LOAD_FAILED", "本地配置无法安全加载或检查未完成", "检查当前运行用户、环境文件读权限及格式、必要本地依赖；不显示文件路径、配置内容或异常详情。"));
  }
}
await main();

