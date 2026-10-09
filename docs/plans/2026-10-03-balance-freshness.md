# Balance Freshness Implementation Plan

> **For agent:** REQUIRED SUB-SKILL: Use Superpowers Section 4 to implement this plan.

**Goal:** 完成阶段 3：金额旁展示真实来源、记录时间与最近查询失败，测试连接不冒充余额更新。
**Architecture:** 来源取当前实际余额快照，不按平台或诊断推断；使用稳定快照引用与索引关联，兼容旧 SQLite 与 v1/v2 备份。单独保留最近余额查询诊断，纯展示函数供列表、地图、详情共享；整个工作区只有一个可见时运行的本地分钟时钟，不查询网络。
**Tech Stack:** Next.js / React / TypeScript / SQLite / Drizzle / Vitest / Playwright。

**审查后修订：** 来源与记录时间均只取快照；旧错误固定文案脱敏。补充 UTC 毫秒排序键、持久化序号与当前快照引用，新备份 v3（兼容旧 v1/v2 导入）。旧备份合并保持已知序号，歧义、逆序锚点、冲突与跨账号引用预览/提交都原子拒绝；新记录不被旧未来时间挡住。余额查询状态/诊断/快照事务化关联，不用近似时间匹配；所有浏览器回归使用无环境文件的临时运行目录和环境变量白名单，实际失败请求截图验收。

## 1. 数据契约（本地实施）

- `tests/freshness-store.test.ts`：先验证缺失来源的 RED；覆盖手动/接口/零/未知、失败与测试分离、编辑归档、重启、旧快照、备份还原。
- `src/lib/store.ts`, `src/lib/validation.ts`, `src/lib/api.ts`：公开 `balanceSource`，从真实快照关联；独立保存 `lastSyncDiagnostic`，备份仍不含诊断。
- 运行 `npx --no-install --offline vitest run tests/freshness-store.test.ts`，观察 RED → GREEN。

## 2. 共享展示与时钟（本地实施）

- `tests/freshness.test.ts`：来源不可推断、时间边界/未来时间/非法时间、最近测试不覆盖失败刷新；时钟隐藏暂停、恢复与销毁。
- `src/lib/balance-freshness.ts`, `src/components/balance-freshness.tsx`, `src/components/use-freshness-clock.ts`, `src/components/balance-freshness.css`。
- `src/components/workspace.tsx`, `src/components/atlas-map.tsx`：同一时间/语义，明确上次金额；绝对日期可访问；不改地图几何、不增加常驻动效。

## 3. 验收与交付

- `scripts/verify-freshness.ts`：隔离数据库、端口与 HTTP 夹具；实际点击、测试/刷新分离、页面时间更新无请求、375/768/1440 浅深色/减少动效、地图稳定截图。先断言旧 UI RED，再 GREEN。
- 运行完整 `npm test` / `npm run typecheck` / `npm run build` 与新旧相关浏览器脚本。
- 必须独立只读审查（Superpowers Section 10）；与本地浏览器验收并行，修复重要问题。
- 更新 `docs/STATUS.md`、产品路线与短使用说明；不提交、不推送。

## 2026-10-03 完成 checkpoint

- 250 项自动化测试、类型检查与生产构建通过；最后重要审查问题已独立静态复核关闭，有 RED → GREEN 及不改数据断言。
- 当前构建 `ujrGSGdskaxmJUbRTYOTw`：新鲜度 13、原界面 10、交互 18、平台 8、向导 25、诊断 28 检查全部通过。最终新鲜度报告：`output/playwright/freshness/2026-10-03T08-12-52.298Z/verification.json`；完整报告、短续接入口见 `docs/STATUS.md` 与产品路线。
- 无真实配置 / 站点 / 凭据 / 余额修改；无自动查询、DoH 启用或代理；验收服务已清理，未提交 / 推送。阶段 4 / 5 未开始。

## 部署与验证限制

不修改真实数据、.env.local、凭据、密码；不后台查询/重试、不启用 DoH/代理。第三方站点 的真实成功尚未确认；Docker 未执行。阶段 4/5 不启动。
