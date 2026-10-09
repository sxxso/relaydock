# 贡献指南

欢迎贡献兼容站点适配、故障反例和界面改进。本文件提供协作规范，不等于已经发布；本项目经用户确认采用 [MIT License](LICENSE)，版权署名为 cjmarklll。许可证已确定不代表已经发布，不擅自推送或上传数据。

## 本地开发

需要 Node.js 22.20+，执行 `npm ci`。新部署按 README 初始化；**已有部署不要再次 setup 或重置密码**。生产构建用 `npm run build`，开发用 `npm run dev`；普通预览绑定本地回环。

不能提交 `.env*`（除示例）、`data/`、数据库/WAL、密钥/哈希、浏览器状态、用户备份或请求响应原文。截图、测试数据和 Issue 只使用合成样本。项目测试内置临时数据库/本地 HTTP，浏览器测试复制隔离构建，不加载真实环境文件。

部署检查用 `npm run doctor`（开发模式加 `--development`），详见 [自检说明](docs/DOCTOR.md)。doctor 回归使用临时合成配置，网络和子进程调用被阻断；不要把你的真实配置目录作为测试夹具。

## 新增平台：小范围贡献流程

先说明端点、认证类型、**账户余额还是令牌额度**、字段格式和币种来源，附官方文档；版本未知就写响应合同，不凭域名猜测。不支持执行 CC Switch 等工具里的任意脚本，但可将其可验证规则改写为安全声明式解析。

1. 在 `src/lib/adapters/<provider>/` 增加 `metadata.ts`、`index.ts`、`fixtures.json`。参考 `generic/`（最简单）或 `openrouter/`（精确扣减），不要复制整套查询编排。
2. 先写合成夹具与预期：成功、零、缺字段/非法金额、业务拒绝、不安全数值；适用时增加币种重复、无限额度、扣减负数、换算未确认和地址前缀。运行测试确认 RED，再写最小实现。
3. 实现 `BalanceAdapter`。复用 `responseBody / buildRequest / readPath / decimalValue / decimalResult`，金额是精确十进制字符串，不允许 Number 累加或虚构零。适配器不能拿凭据、网络客户端、store，也不能发起任何请求。
4. 更新 `src/lib/validation.ts` 的账号及草稿 provider 白名单、`src/lib/query-diagnostics.ts` 的诊断 provider 白名单；向 `adapters/index.ts` 显式注册。类型穷尽检查能发现漏项，**不使用运行时扫描或动态模块路径**。
5. 在 `platform-catalog.ts` 只导入本平台 metadata，避免把服务端解析/库带入浏览器。菜单名、能力和服务器共用这一对象。新增单位/口径必须同时检查 `account-wizard.ts` 的单位确认、`money.ts` 的汇总隔离和备份兼容，不能强制猜测。
6. 更新 `tests/adapter-contract.test.ts` provider 集合和合同断言；扩展本地 HTTP 平台 API、草稿测试及 `scripts/verify-platforms.ts` 的夹具。七个旧平台也必须保持通过，不能删掉断言掩盖不兼容。
7. metadata 写清 capability、compatibility 和三种验证日期。fixture/docs/live 分开，未实际授权验证的 live 日期是 `null`。当前基线的“七平台 live=null”断言只有在有脱敏实测证据且范围获得授权时才能有意更新，不能靠删除断言冒充实测。
8. 更新 `docs/ADAPTERS.md` 和 README 的支持矩阵；说明新端点的兼容范围及未验证项。提交前附测试结果与合成反例，不附密钥或用户数据。

接口示例（仅形状，参考实际目录的完整实现）：

```ts
export const adapter = {
  metadata,
  buildRequest: (account) => buildRequest(account, metadata),
  parse: (body, account) => {
    responseBody(body, account);
    return decimalResult(decimalValue(readPath(body, "balance")), account.unit);
  },
} satisfies BalanceAdapter;
```

`fixtures.json` 中 `synthetic=true`；`request.account` 是账号配置覆盖、`request.expected` 是四字段请求；`cases` 使用 `body/account/expected` 或 `error`。错误夹具的 `provider_rejected` 对应业务拒绝，`invalid_balance` 对应非法合同；HTTP 401/429/超时由公共出站层识别，不要解析未经信任的 message 来猜权限。

## 验收命令

```powershell
npm test
npm run typecheck
npm run build
npm run test:platforms
npm run test:wizard
npm run test:diagnostics
npm run test:freshness
npm run test:management
npm run test:interactions
npm run test:e2e
```

浏览器回归必须对同一新构建运行。脚本会占用 3317–3323 等测试端口；先检查端口归属，不杀其他进程。格式化只限修改文件：`npx prettier --write <paths>`；不要重排全仓或改其他项目。

## 不变原则 / Issue

- 只在明确操作时请求外站，无自动轮询、后台签到或充值。模型公开接口仅在 HTTP 401 时追加一次管理凭据读取，余额查询不重试；签到与邀请使用固定端点、缓存和主动按钮。DoH 与查询代理保持显式配置，不自动接管系统网络。
- 所有请求经过现有登录/CSRF、安全 DNS 固定 IP、重定向/元数据/内网限制和总截止时间；禁止为某站绕过 TLS 或 SSRF 防护。
- 错误保留上次真实快照，测试不保存余额；未知不能等于零，币种/令牌额度不能混算。
- 复现信息包含平台、操作、固定错误码、版本/构建与脱敏诊断报告。密钥、用户 ID、完整余额和私有地址请不要上传；不自动上传 Issue。
- 完成工作先评审/回归，短记录写入 `docs/STATUS.md`，不依赖整段聊天作为说明。


## 自动验收与提交范围

未来独立仓库以应用目录为根，不包含上级技能库或其他作品。`package.json` 保持 `private=true`，避免误发布 npm；应用自身许可证为 MIT，版权声明为 `Copyright (c) 2026 cjmarklll`，不沿用上级仓库版权头。

`.github/workflows/ci.yml` 在 main/master push、PR 和手动触发时执行：

1. `npm ci`、安装 Chromium、`RELAYDOCK_MAP_GESTURES=1 npm test`（POSIX 示例）、`npm run typecheck -- --incremental false`、`npm run build`。
2. 三个独立浏览器 job：`npm run ci:browser -- interface|query|management`。入口覆盖十五套回归，未知组拒绝，失败即停；query-focus、模型表现、签到及邀请显式传 `--ready`，最新外观由 query-focus 覆盖。
3. `npm run test:docker -- --ready`：新镜像、内部合成夹具、非 root、重启持久化与数据库/主密钥整卷迁移，不使用现有容器或真实数据卷。

Windows 全量手势测试可使用：

```powershell
$env:RELAYDOCK_MAP_GESTURES = "1"
npm test
Remove-Item Env:\RELAYDOCK_MAP_GESTURES
```

Actions 固定官方提交 SHA，默认只读仓库权限，不使用 `pull_request_target` 或真实 secrets，不上传 `.next`、环境文件、数据库、原始服务日志/DOM/trace。验收只访问本地合成服务；安装依赖和容器构建的网络下载不算实站余额验证。

变更须通过 Core checks、三组 Browser regression 和 Docker persistence and migration；仓库创建后由维护者在分支规则中设为 required checks。本地命令通过不等于 GitHub 已执行，单测通过也不等于 Docker 已验证。

Bug/平台 Issue 请使用表单并只提供复制白名单诊断或合成反例。不请求贡献者在公开 Issue 中发送 API Key、Cookie、用户 ID、数据库或完整迁移包。

发布前按 [发布检查清单](docs/RELEASE-CHECKLIST.md) 复核，公开截图范围见 [截图来源](docs/SCREENSHOTS.md)。

导出独立源码请使用 [开源准备流程](docs/OPEN-SOURCE.md) 中的 `release:prepare`，先检查再导出；不得将父仓库或真实部署数据一起提交。依赖变化后重新运行 `release:notices` 并审阅差异；安全问题见 [SECURITY.md](SECURITY.md)。

