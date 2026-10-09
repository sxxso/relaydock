# 平台适配器 · 合同与验证记录

阶段 5 将七个查询模板拆为独立目录；不增加新的查询口径、后台请求或用户脚本。手动记录没有网络适配器。旧 `lib/new-api.ts` 导出仍可用。

## 代码导航

```text
src/lib/adapters/
  types.ts                      请求/结果/能力/验证元信息合同
  shared.ts                     纯 URL、响应和十进制工具
  index.ts                      穷尽静态注册与分发
  <provider>/
    metadata.ts                 浏览器可用的纯元信息
    index.ts                    本平台 buildRequest / parse
    fixtures.json               合成响应、请求与预期错误
src/lib/platform-catalog.ts     只聚合 metadata，维持旧菜单顺序
src/lib/query-balance.ts        安全出站、诊断编排；不负责持久化
src/lib/outbound.ts             固定解析 IP、超时/响应上限/SSRF 防护
src/lib/api.ts + store.ts       登录/CSRF、忙碌保护、成功快照与失败保留
```

`buildRequest(account)` 返回 `url / timeoutSeconds / authHeader / userId`，没有凭据。`parse(body, account)` 返回字符串 `balance / unit` 和 `rawQuota: string | null`；未知、无限、无效或负结果抛错，不能返回假零。两者必须是无网络、无持久化、无定时器的同步纯函数，不修改账号或响应。

最终金额沿用持久化合同：最多 24 位整数、12 位小数。即使配额与换算系数各自合法，商仍可能溢出；账户及令牌都在解析时拒绝，测试/刷新一致返回 `invalid_balance`，保留原始配额解析规则与已有快照，而非测试假成功。

查询凭据只交给公共安全出站层，浏览器不请求供应商；外部响应正文、头、错误 message 不写入诊断。测试与刷新走同一路径，测试不记账；失败保留上次快照。仅明确点击才执行，不猜端点、不重试、不自动探测。

## 已支持的响应合同

不是“所有发行版本认证”：上游及中转分支没有共同版本保证，因此按端点和字段合同标注兼容。文档核对、合成夹具和实站验证分别记录，不能互相替代。

| 目录           | 请求与认证                                    | 读取合同 / 口径                                       | 限制                                                         |
| -------------- | --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| `newapi`       | `/api/user/self`，管理令牌，按站点要求用户 ID | `success=true; data.quota`，账户原始整数配额          | 未确认系数保留“配额”，不默认换算                             |
| `newapi-token` | `/api/usage/token`，API Key                   | `code=true` 或 `success=true`，`data.total_available` | `unlimited_quota=false` 才记账；只该令牌，不混入账户币种合计 |
| `generic`      | `/user/balance`，API Key                      | 顶层 `balance`                                        | 站点约定；金额单位由部署者确认                               |
| `deepseek`     | `/user/balance`，API Key                      | `balance_infos` 中唯一所选币种的 `total_balance`      | 不混加 CNY/USD；`is_available=false` 仍可能有真实零余额      |
| `openrouter`   | `/api/v1/credits`，Management Key             | `data.total_credits - data.total_usage`，USD          | 普通模型 Key 不一定有权限；负结果拒绝                        |
| `siliconflow`  | 旧 `/v1/user/info`，API Key                   | `data.totalBalance`，CNY                              | **仅旧接口兼容**，不承诺官方现可查询                         |
| `custom`       | 配置的同源 GET，三种白名单认证头              | `(balancePath - subtractPath) / divisor`              | 声明式字段映射；不接受 URL 参数、目录跳转、原型字段或代码    |

New API 的用户接口及令牌口径分别参照 [用户模块](https://doc.newapi.pro/en/api/fei-user/) 和 [令牌使用量文档](https://doc.newapi.pro/en/api/token-usage/)；管理接口新文档列出了 [当前用户端点](https://docs.newapi.pro/en/docs/api/management/user-management/user-self-get)。[DeepSeek 文档](https://api-docs.deepseek.com/api/get-user-balance/)说明余额按币种返回；[OpenRouter 文档](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)注明需要管理密钥。[SiliconFlow 官方公告](https://docs.siliconflow.cn/docs/release-notes/overview)说明 `/user/info` 于 2026-08-14 停止服务，所以保留的只是旧合同解析。

## 验证日期

每个平台 `metadata.verification` 独立保存：

- `fixturesVerifiedOn`：合成夹具最近通过日期；原模板为 **2026-10-03**，自定义 usage 预设为 **2026-10-04**；必须有对应自动化证据。
- `docsReviewedOn`：最近实际核对上游文档的日期。通用/自定义是项目约定，留 `null`；其他预设本轮为 2026-10-03。
- `liveVerifiedOn`：经授权使用真实站点及正确凭据成功的日期。**当前七个平台全为 null**，不是官方可用性保证。第三方站点 真实余额成功仍未确认。
- `docs`：可公开来源链接；没有真实站点、账号、密钥、请求响应正文。

文档更新不意味着接口已实测；不要把运行测试的日期写成实站成功日期，也不虚构兼容发布版本。

## 回归入口

`tests/adapter-contract.test.ts` 遍历各目录响应夹具和请求合同，并核对直接适配器、统一分发及旧导出。`tests/adapter-boundaries.test.ts` 跟踪运行时静态导入，避免 metadata 引入解析/网络，禁止适配器绑定数据库/出站或执行脚本。`tests/platform-api.test.ts` 用临时 SQLite 和本地 HTTP 验证七平台认证、测试不记账、刷新记账、错误保留及脱敏。浏览器 `npm run test:platforms` 覆盖七个平台和真实慢响应/超时夹具。

```powershell
npx vitest run tests/adapter-contract.test.ts tests/adapter-boundaries.test.ts tests/platforms.test.ts tests/platform-api.test.ts
npm run typecheck
npm run build
npm run test:platforms
```

测试无须真实密钥；不要为了通过测试启用 DoH/代理或修改真实 `.env.local`/数据目录。完整交付仍需 `npm test` 与七套 UI 回归。贡献步骤见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
