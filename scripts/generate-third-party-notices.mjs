import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Offline inventory from the committed lockfile and installed npm package notices.
// No downloads, npm execution, deployment configuration or credentials.
const root = resolve(process.cwd());
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
assert.equal(lock.name, "relaydock-atlas");
const rows = Object.entries(lock.packages).filter(([name, info]) => name && !info.dev).sort(([a], [b]) => a.localeCompare(b, "en"));
const installed = [], absent = [], missingNotices = [];
for (const [name, info] of rows) {
  assert.ok(/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(name), "Unexpected package path");
  assert.ok(info.license, "Missing license metadata: " + name);
  const dir = join(root, name);
  if (!existsSync(join(dir, "package.json"))) {
    assert.ok(info.optional, "Required dependency is not installed: " + name);
    absent.push(name);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.version, info.version, "Installed dependency differs from lockfile: " + name);
  const notices = readdirSync(dir).filter((file) => /^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(file) && lstatSync(join(dir, file)).isFile()).sort();
  if (!notices.length) missingNotices.push(name);
  installed.push({ name, notices: notices.map((file) => ({ file, text: readFileSync(join(dir, file), "utf8").trim() })) });
}
const lines = [
  "# Third-party notices / 第三方依赖说明", "",
  "RelayDock 自身源码采用 MIT（cjmarklll）；第三方依赖继续适用各自许可证。此文件由 `npm run release:notices` 根据 package-lock.json 及本机已安装包离线生成，不代表上游全部内容或跨平台二进制已经完成许可审查。", "",
  "源码导出包不包含 node_modules 或第三方二进制。容器或运行时分发前，应在对应平台安装精确锁定依赖，核对实际镜像中所有组件、许可原文、署名及源码获取说明；尤其包括 sharp/libvips 的 LGPL 条目及 caniuse-lite 的 CC-BY 条目。Windows 采集的原文不能代替 Linux 镜像核对。", "",
  "图标来自 lucide-react，字体使用系统字体；docs/images 的截图均来自应用合成数据验收，当前 PNG 与历史 WebP 在截图说明中分别标记。地图底纹与界面图形由项目代码生成，没有打包外部品牌原图。", "",
  `锁文件生产依赖路径：${rows.length}；本机安装：${installed.length}；未安装的可选平台包：${absent.length}。开发工具依赖未包含在本运行时清单中，源码开发安装时请保留其 npm 包原有许可。`, "",
  "## 锁定生产依赖", "", "| npm 包路径 | 版本 | 声明许可证 | 本机原文 |", "| --- | --- | --- | --- |",
  ...rows.map(([name, info]) => `| ${name.replace(/^node_modules\//, "")} | ${info.version} | ${info.license} | ${absent.includes(name) ? "未安装（可选平台包）" : missingNotices.includes(name) ? "包根目录未附原文，分发前补核" : "下方保留包内原文"} |`), "",
  "## 尚需核对", "",
  ...missingNotices.map((name) => `- ${name.replace(/^node_modules\//, "")}：当前 npm 包根目录未附 LICENSE/LICENCE/NOTICE/COPYING；此清单不补造版权或许可声明。`),
  "- 所有未安装的可选平台包及最终 Docker 镜像中的二进制与内嵌组件。", "",
  "## 已安装生产包原文", "",
];
for (const pkg of installed) for (const notice of pkg.notices) {
  const fence = "`".repeat(Math.max(4, ...[...notice.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  lines.push(`### ${pkg.name.replace(/^node_modules\//, "")} / ${notice.file}`, "", fence + "text", notice.text, fence, "");
}
writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), lines.join("\n") + "\n");
console.log(JSON.stringify({ productionPackages: rows.length, installed: installed.length, optionalNotInstalled: absent.length, missingNoticeFiles: missingNotices, output: "THIRD-PARTY-NOTICES.md", scope: "local installed production packages only" }, null, 2));
