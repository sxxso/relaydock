# 模型表现面板 Implementation Plan

> **For agent:** Use Superpowers Section 5 with TDD, specification review, quality review, and fresh isolated verification. The user approved the integration design and staged implementation on 2026-10-08.

**Goal:** 为 New API 账户增加按点击读取的模型目录、站点表现和个人日志表现，具有明确来源、时间、缺失值、截断提示和趋势。

**Architecture:** 独立共享数据合同、纯解析模块和服务；复用受控 GET 出站与部署线路。缓存保存独立 SQLite 表，不写余额、快照或原始日志；详情内嵌入口打开宽屏模型面板，首次不自动读取外站，已有缓存可读，刷新／改变查询窗口通过明确按钮执行。

**Tech Stack:** 当前 Next.js 16.3.8 / React 19.3 / TypeScript / SQLite / Vitest / existing Playwright isolated-source harness. Do not install dependencies, load deployment .env/data, change a running dev service, commit the parent repository, or operate real providers. The app is an untracked subtree of the parent repository, so Git worktrees would omit its source; implement in the authorized app directory and use isolated source builds.

**Status:** Task 1/2/3 completed on 2026-10-08. Backend and UI specification/quality reviews passed. Final checks: 54 test files, 883 tests, no skips; nonincremental typecheck; new production builds and browser checks (model panel 21, existing query/map 26). Evidence: `output/model-insight-acceptance.json`. Phase 2 remains pending.

## 范围与界面

- 首轮支持 `provider=newapi`（账户管理凭据）；其他模板的账号详情说明需要 New API 账户模板，不猜测平台或使用模型 Key 签到。
- 使用 frontend-design，沿用现有字体和主题变量：浅色纸面、深色海蓝、青蓝强调与珊瑚失败色。信息表格按模型与数值对齐；手机保留模型名、成功率和关键状态，其余指标展开显示。原有详情布局和地图稳定。
- 入口「模型表现」，标题标出账号；读取模式「站点优先／我的调用记录」、24/72/168 小时、搜索、有流量过滤、排序、单模型趋势、更新按钮。
- 来源、读取时间、窗口和限制总是显示；空／错误／忙碌有可见反馈。失败保留上次缓存并标为旧数据。
- 统计不证明当前调用成功；目录不是权限证明。无数据不显示 0%。日志速度称为估算，不能混用 TPS 口径。
- 不加入签到、推理测试、自动轮询或定时任务。

## 内部 API 与共享数据合同

- `GET /api/accounts/:id/models`：仅本地缓存，无外站请求，返回 `{ insight: ModelInsight | null }`。
- `POST /api/accounts/:id/models`：受登录／Origin／CSRF 保护，strict 输入 `{ hours: 24|72|168, source: "auto"|"log", routeMode?: "direct"|"proxy" }`；返回 `ModelInsight`。
- `POST /api/accounts/:id/models/detail`：同样保护，输入 `{ hours, source: "perf"|"log", model: string, routeMode? }`；返回 `ModelDetail`。model 有长度上限，不可指定 URL／凭据。
- 每账号模型请求加锁（隔离 Store／数据库作用域），归档／平台不支持／参数非法在联网前拒绝。服务器捕获请求开始的线路。
- `ModelInsight`: version=1, accountId, readAt (ISO), hours, source (perf/log/catalog), windowStart/windowEnd (ISO|null), rows, truncated, catalogAvailable, warnings（固定文案）。
- `ModelRow`: model, vendor, groups, inCatalog, successRate, avgLatencyMs, avgTtftMs, avgTps, sampleCount, trend。所有缺失数值为 null；model/group/vendor 和 rows/points 数量有界。
- `ModelPoint`: at (ISO|null), successRate, avgLatencyMs, avgTps, avgTtftMs。旧 recent_success_rates 没有时间戳时 at=null，不伪造时间。
- `ModelDetail`: version=1, accountId, model, hours, source, readAt, windowStart/windowEnd, groups（group、上述指标、series）、truncated、warnings。

## Task 1 — Backend and contracts

**Files:** create `src/lib/model-insight.ts` (client-safe types/parsing/filter helpers), `src/lib/query-model-insight.ts` (server orchestration), `tests/model-insight.test.ts`, `tests/model-insight-api.test.ts`; change `outbound.ts`, `store.ts`, `api.ts`.

1. Write meaningful failing parser / local-HTTP / API tests and run `npm test -- --run tests/model-insight.test.ts tests/model-insight-api.test.ts`; preserve RED evidence.
2. Parse static allowlisted New API paths: `/api/status`, `/api/pricing`, `/api/perf-metrics/summary`, `/api/perf-metrics`, `/api/log/self`. Normalize management root the same way as the balance adapter; preserve subpath prefixes. Only typed hours/model/page/time query parameters.
3. Extend safeJsonRequest with internal anonymous-auth and optional absolute deadline only. Keep GET-only, DNS pinning, proxy, TLS, redirect rejection, wire/decoded limits and old balance behavior. Shared deadline for an entire operation; no extra retries except one credential attempt after a public endpoint returns 401.
4. Public status and initial pricing/perf calls omit credential headers. Permission failures retain distinct messages. Only HTTP 404 triggers automatic log fallback; explicit log source also supported. Partial catalog results may survive metrics failure with warnings. No raw upstream messages, body, headers or logs returned/persisted.
5. Logs: max 6 pages × 100, filtered window, count consumption type=2 / error type=5, ignore unrelated records. Read use_time seconds/frt ms/completion_tokens; numeric validation, nulls, explicit incomplete/truncated state. Full page at cap is conservatively truncated. Check returned data/page metadata without endless paging.
6. Persist validated aggregate only in independent `model_insights` table keyed by account ID. No updates to accounts/secret/snapshots/meta or backup v3 format. Cache excludes raw logs; reject/ignore corrupt cached shapes and account identity mismatch. Account deletion removes its cache.
7. Run targeted tests and nonincremental typecheck. Report changed files, RED/GREEN commands, contract, limits and any concerns; no commit.

## Task 2 — UI and isolated browser acceptance

**Files:** create `src/components/model-insight-panel.tsx` and `.css`, `scripts/verify-model-insight.ts`; change minimal `workspace.tsx` integration and `package.json` test script.

1. Write browser acceptance before UI, using current `scripts/build-source-isolated.ts`, local synthetic New API servers, random loopback ports and temporary Store. Run once with `--ready` and confirm missing UI fails; don't use deployment data or .next.
2. Implement client component. Fetch only local cache when opened, external reads only on explicit buttons. Reset per account; discard late replies for closed panel / changed account / changed query. No intervals. Capture route mode, correctly disable conflicting controls and retain old results on failure.
3. Search/filter/sort locally without external requests. Expand rows only with explicit detail request; keyboard, mobile, light/dark and reduced-motion behavior checked. Trend missing/legacy time stays explicit.
4. Run isolated browser acceptance. Count and allowlist all external requests; assert GET-only and no inference/checkin paths; verify source fallback, cached reopen, read time, 24/72/168, detail, unknown metrics, sampling and no idle queries, screenshots at 375/768/1440 light/dark.

## Task 3 — Review and delivery

1. Fresh spec review then code-quality review with independent agents; repair defects and rerun affected checks.
2. Fresh `npm test`, `npm run typecheck -- --incremental false`, isolated production build and browser verification. Existing outbound/query regressions must pass. Use the browser script's fresh build as build evidence, not the active .next.
3. Visually inspect generated screenshots and any relevant failure state. Preserve bounded reports/screenshots, safely clean only owned temporary fixtures/processes.
4. Add `docs/MODEL-INSIGHT.md`, update README/STATUS/integration plan with actual evidence. Phase 2 remains pending until Phase 1 passes.
