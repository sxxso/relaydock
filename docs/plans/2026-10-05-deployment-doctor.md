# 第二阶段：本地部署自检实施计划

> For agentic workers: 使用 superpowers:executing-plans、test-driven-development 与 verification-before-completion 内联实施。用户于 2026-10-05 要求开始第二阶段，沿用已确认的只读、本地、不泄露秘密设计。不提交、推送或创建仓库；不启动第三阶段。

**Goal:** 用 `npm run doctor` 告诉用户部署哪里没配好，而不是启动后才遇到异常。

**Architecture:** 独立 Node ESM 命令与检查库，不导入会初始化数据库的 Store/API，不启动服务。环境变量按 Next 的当前模式优先级读取（默认 production，可 `--development`）；已有 shell 变量优先。只返回固定白名单结果。SQLite 检查使用有大小上限的内存只读副本，不打开原文件为 SQLite 连接、不产生 WAL/SHM。检测到非空 WAL/回滚日志或读取过程中文件变化则 WARN，提示停止服务再检查，不忽略未合并记录。

**Tech Stack:** Node >=22.20.0、已安装的 @next/env（Next 依赖）、better-sqlite3、node:fs/crypto、Vitest。零新增第三方依赖。

**Spec:** 用户六阶段要求第 2 项，以及当前会话确认的本地只读检查设计。

## 全局边界

- 不读取真实部署 .env.local、vault.key、atlas.sqlite 做开发验收；全部使用独立临时合成夹具。
- 命令无 HTTP、DNS、代理 CONNECT、遥测、外站探测、shell 执行或后台任务。
- 不创建数据目录、密钥、数据库、会话，不迁移或修复，不打印路径、地址、配置值、异常详情、密码、哈希、密钥、凭据或解密结果。
- 目录权限采用只读 access 检查，不创建探针；明确不是实际写入或磁盘空间保证。
- 数据库副本上限 64 MiB；超限 WARN 而不是加载无限历史到内存。数据库只做 quick_check、表/列合同、管理员元数据和加密凭据认证，不读取账号名称/历史 payload。
- 首次未初始化的数据库/密钥为 WARN；已有数据库缺失密钥或解密不匹配为 FAIL，绝不建议随意生成替代密钥。
- 退出码 0=全部 PASS，1=存在 WARN 且无 FAIL，2=存在 FAIL/使用错误。JSON 使用 `schemaVersion/status/exitCode/checks` 稳定合同。
- 已有数据库 adminHash 优先，环境密码仅用于首次初始化；区分错误配置与被忽略的初始配置。
- 原项目 .next、父仓库 Sakura 工作、数据和真实配置不改。应用尚未独立 Git 初始化，因此在现有应用目录中限定文件集工作；无工作树、分支或 Git 提交操作。
- 第一阶段 Docker 及首次远端 CI 未实测继续保持待办，不能把本阶段单测等同容器执行。

## Task 1: 检查库（测试先行）

Files: `tests/doctor.test.ts`（新）、`scripts/doctor-lib.mjs`（新）。

Interfaces: `checkNodeVersion(version): boolean`; `checkConfiguration(env): Check[]`; `runDoctor({cwd, env, nodeVersion?, fs?}): Promise<Report>`；所有 Check 仅包含 `id/status/code/message/advice`。

- [x] 写 Node 边界、认证/主密钥/公开地址/DNS/代理/精确私有主机配置反例；fixture 输出包含敏感字符串时必须失败。
- [x] 执行 `npm test -- tests/doctor.test.ts` 观察缺少实现的 RED，再实现最小检查逻辑并重跑 GREEN。
- [x] 写真实合成 SQLite 的健康/损坏/旧排序列/缺表/只读权限/错误密钥/多凭据中混入错误密钥/WAL/数据库过大/源文件不变反例；先 RED 后 GREEN。
- [x] 安全权限异常通过注入 fs access 边界验证，真实数据库和密码算法不 mock。临时夹具删除前检查绝对路径和所有权。

## Task 2: CLI、交付与说明（测试先行）

Files: `tests/doctor-cli.test.ts`（新）、`scripts/doctor.mjs`（新）、`package.json`、`Dockerfile`、`scripts/docker-smoke-lib.mjs`、`tests/docker-delivery.test.ts`、`README.md`、`docs/DOCTOR.md`（新）、`CHANGELOG.md`、`docs/STATUS.md`、`docs/RELEASE-CHECKLIST.md`。

Interfaces: `node scripts/doctor.mjs [--json] [--development]`；`npm run doctor -- --json`；Docker `node scripts/doctor.mjs --json`。

- [x] CLI 子进程用合成 cwd、清空部署环境、断网 preload 验证普通与 JSON 输出、真实退出码、shell 优先级、production/development env 层级与变量展开、未知参数不回显。
- [x] 先观察 RED 后实现；错误只返回固定检查项，不转发日志或 stack。
- [x] npm 增加 doctor，不改变依赖图/锁定版本；Docker 白名单及运行镜像保留 doctor 两个脚本与 @next/env。增加上下文行为回归；仅编写/单测，不声称已运行镜像。
- [x] README 启动前自检入口；文档清楚解释 WARN、只读权限检查局限、WAL/大数据库未验收边界、数据备份与主密钥恢复建议。检查所有本地 Markdown 链接。

## Task 3: 本阶段验收与台账

- [x] 实际运行全量 `RELAYDOCK_MAP_GESTURES=1 npm test`，记录文件/通过/跳过数；`npm run typecheck -- --incremental false`、JS 语法及 Markdown 链接检查；本轮未修改 CI YAML，不重复声称 actionlint 是本轮运行。
- [x] 离线 fixture 运行真实 npm 命令，留存脱敏 JSON/退出码；审查 doctor 无网络调用和无真实数据写入。
- [x] 更新本计划、STATUS 与发布清单；机器结果保存在忽略的 `output/stage2-doctor-2026-10-05/verification.json`。
- [x] 明确本轮未重跑生产构建、十二套浏览器或 Docker；本阶段仅脚本交付，保留历史证据而不声称它们是本轮结果。

## 独立审查修复（2026-10-05）

- [x] P2：主文件缺失但有真实 WAL，旧版误报 DATABASE_UNINITIALIZED。用真实孤立 WAL 验证 RED；修复后 FAIL / DATABASE_RECOVERY_INCOMPLETE，admin/vault 匹配未验证，不创建空库、不删除恢复材料。另覆盖孤立 SHM/回滚日志。
- [x] P2：静态热回滚日志的等长未提交页，旧版误报 DATABASE_HEALTHY。真实 SQLite 事务缓存溢写夹具与读取后新日志反例均 RED；修复前后检查 WAL/回滚日志，不只看主文件 quick_check，不执行恢复。
- [x] 两项修复后的复审与最终全量验收。



## 最终本地结论（2026-10-05）

- 最终全量：41 文件、784 项通过，0 跳过（全部地图手势开启）；doctor 检查库 54 项、CLI 17 项，doctor/交付定向合计 90 项通过。
- 非增量类型、三个修改 JS 语法、32 份 Markdown / 43 处本地链接通过。真实 npm 入口在合成项目运行通过；不读取真实部署进行验收。
- 独立复审确认原两项 P2 解决；7 个定向合成用例及文件字节/修改时间保留断言通过，复现目录均已清理，无新的具体 P1/P2。热日志夹具实测 1200 行可能超过 70 秒，缩为 80 行，仅夹具禁用同步；仍独立证明主文件中含有效结构但未提交管理员页，不掩盖原错误分支，不修改生产 SQLite 配置。
- 普通输出、JSON、退出码、env 优先级、无网络/子进程、源文件不变、凭据全部认证、丢失/错误密钥、损坏/旧库/WAL/journal/孤立侧车/大数据库均已覆盖。
- 本阶段本地功能验收完成，未提交或推送。Docker 入口只有打包/白名单配置及单测，尚未镜像实测；生产构建、十二套浏览器与 CI YAML lint 本轮未重跑，保留第一阶段历史证据与 Docker/首次 GitHub CI 待办，不进入第三阶段。
- 机器报告：`output/stage2-doctor-2026-10-05/verification.json`，完整日志同目录，忽略不发布。
