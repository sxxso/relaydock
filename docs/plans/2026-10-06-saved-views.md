# 保存常用视图 Implementation Plan

> **For agentic workers:** 本计划在当前会话内按 TDD 执行；每项任务先写失败测试，再做最小实现。不得把保存视图切换误认为触发查询。

**Goal:** 允许用户保存、切换、覆盖和删除本地筛选组合，并让地图与列表共享同一份本地筛选结果。

**Architecture:** 保存视图使用独立的元数据 JSON，避免设置页更新时意外覆盖视图；账号接口返回视图列表，新增受认证和 CSRF 保护的保存/删除接口。筛选条件集中到纯函数，列表和地图继续消费同一个 `filtered` 与 `matchingIds`。

**Tech Stack:** Next.js 16、React 19、TypeScript、Zod、better-sqlite3、Vitest、Playwright。

**Spec:** 用户确认的第四阶段设计：保存命名筛选组合；列表和地图共用；只筛选已有数据，不触发查询。

## Global Constraints

- 保存视图只操作本地已有 `Account[]`，切换视图不得调用同步、测试或查询接口。
- 视图数据不包含凭据、余额历史或查询诊断。
- 兼容没有 `savedViews` 字段的旧备份与旧元数据。
- 单部署最多保存 50 个视图，名称最多 40 个字符。
- 不使用 `localStorage`，不访问外站，不读取真实生产配置验收。

---

### Task 1: 筛选条件与保存视图契约

**Files:**
- Create: `src/lib/saved-views.ts`
- Create: `src/lib/account-filter.ts`
- Test: `tests/saved-views.test.ts`

- [x] 写保存视图 schema、默认筛选条件、筛选和七天未记录规则的失败测试。
- [x] 运行 `npm test -- tests/saved-views.test.ts`，确认因模块/行为不存在而失败。
- [x] 实现 Zod schema 和纯筛选函数。
- [x] 运行同一测试并确认通过。

### Task 2: 持久化与 API

**Files:**
- Modify: `src/lib/validation.ts`
- Modify: `src/lib/store.ts`
- Modify: `src/lib/api.ts`
- Test: `tests/saved-views-api.test.ts`

- [x] 写 Store 持久化、覆盖、删除、旧元数据兼容和 API 认证/CSRF/不暴露秘密的失败测试。
- [x] 运行目标测试确认失败。
- [x] 实现独立 `savedViews` 元数据、`GET /api/views`、`PUT /api/views`、`DELETE /api/views/:id`。
- [x] 将视图纳入账号响应和不含凭据的数据备份，保持旧备份可导入。
- [x] 运行目标测试确认通过。

### Task 3: 工作区接入

**Files:**
- Modify: `src/components/workspace.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/saved-views.test.ts`

- [x] 将内联筛选替换为纯函数，并加入“超过七天未记录”筛选。
- [x] 增加保存视图选择、保存命名、覆盖、删除和切换 UI。
- [x] 让地图与列表继续消费相同的 `filtered`/`matchingIds`，切换只改本地状态。
- [x] 运行类型检查和相关测试。

### Task 4: 浏览器回归与文档

**Files:**
- Modify: `scripts/verify-management.ts`
- Modify: `docs/STATUS.md`
- Modify: `CHANGELOG.md`

- [x] 在合成管理验收中验证保存、刷新后读取、切换、列表/地图共用以及零查询。
- [x] 运行构建、类型检查、完整测试和管理浏览器验收。
- [x] 更新阶段状态，明确视图切换只筛选已有数据。

