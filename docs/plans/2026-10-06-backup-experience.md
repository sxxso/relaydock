# 备份体验更明确 Implementation Plan

> **For agentic workers:** 本计划在当前会话内按 TDD 执行。不要把 JSON 数据备份描述成可独立恢复凭据的完整迁移，也不要读取真实凭据或访问外站。

**Goal:** 让设置页明确区分“数据备份”和“完整迁移”，并展示最近一次数据备份导出时间。

**Architecture:** 在部署 SQLite 的独立 `backup_status` 表中记录最近一次成功生成 JSON 数据备份的时间；新增只读 `GET /api/backup/status` 返回该状态，`GET /api/backup/export` 生成备份时更新它。设置页进入时读取状态，导出成功后立即刷新本地显示。文案明确 JSON 不含凭据、管理员密码和主密钥；完整迁移需要同一部署的 `data/atlas.sqlite` 与 `data/vault.key`。

**Tech Stack:** Next.js 16、React 19、TypeScript、Zod、better-sqlite3、Vitest、Playwright。

**Scope constraints:**

- 不改变 JSON 备份不含凭据的安全边界。
- 不把主密钥写入 API 响应、备份文件或浏览器状态。
- 不新增“下载完整迁移包”功能；只把现有文件级迁移要求说明清楚。
- 只读 status 接口受登录保护；导出仍由现有认证、Origin/CSRF 路径保护。
- 最近时间记录在本地元数据，不使用 `localStorage`，不访问外站。

---

### Task 1: 状态契约与存储/API

**Files:**
- Create: `src/lib/backup.ts`
- Modify: `src/lib/store.ts`
- Modify: `src/lib/api.ts`
- Test: `tests/backup-experience.test.ts`

- [x] 写备份状态 schema、首次无记录、导出后持久化和重开 Store 仍可读的失败测试。
- [x] 写 `/api/backup/status` 认证契约、导出不泄露凭据/主密钥的失败测试。
- [x] 运行目标测试确认按预期失败。
- [x] 实现最小 schema、SQLite 独立状态表、status endpoint，并让 API export 记录时间。
- [x] 运行目标测试确认通过。

### Task 2: 设置页清晰区分两类备份

**Files:**
- Modify: `src/components/pages.tsx`
- Modify: `src/app/globals.css`

- [x] 设置页加载并展示最近一次数据备份导出时间。
- [x] 导出成功后不刷新页面即可显示新的时间。
- [x] 明确“数据备份：不含凭据、管理员密码、主密钥”。
- [x] 明确“完整迁移：还需要同一部署的 data/atlas.sqlite 与 data/vault.key；JSON 不能恢复凭据”。
- [x] 保持导入预览和现有安全文案不变。

### Task 3: 浏览器回归与文档

**Files:**
- Modify: `scripts/verify-management.ts`
- Modify: `docs/STATUS.md`
- Modify: `CHANGELOG.md`

- [x] 用合成夹具访问设置页，断言两类备份文案和最近导出状态。
- [x] 点击导出并断言最近导出时间出现；刷新后仍能读取状态。
- [x] 断言浏览器与服务器日志中没有主密钥或凭据。
- [x] 运行完整测试、类型检查、构建和管理浏览器验收。
- [x] 更新阶段状态，保留“本地验收不等于 Docker/远端 CI/公开仓库”边界。

