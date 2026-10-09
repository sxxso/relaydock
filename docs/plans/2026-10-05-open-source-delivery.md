# 第一阶段：开源交付与自动验收

**日期：2026-10-05。状态：MIT/cjmarklll 已补入并核验；Docker 实测和远端 CI 待完成。不提交或推送。**

## 目标与约束

以 relaydock 为未来独立仓库根目录，接入已有验收、提供可公开的资料和可复现的容器验收。只修改本应用；不创建上级仓库分支或复制其版权头。许可证已于 2026-10-05 经用户明确确认采用 MIT，版权署名为 cjmarklll。Docker CLI 与 WSL 发行版当前不可用，未实际运行不能宣称容器通过。

- 不读取或修改真实 .env.local、data、主密钥及现有 .next，不调用真实供应商。
- 新文件/脚本先有失败回归；本机生产构建在白名单源文件的隔离副本中执行。
- GitHub 工作流按独立应用根目录布置；checkout 到 relaydock，兼容现有验收目录约束。
- CI 无部署 secrets，contents: read，固定 Actions 提交 SHA，push/PR 触发，明确超时。
- CI 显式 RELAYDOCK_MAP_GESTURES=1，避免默认跳过五项浏览器手势回归。
- 发布是后续六阶段全部完成后的独立动作。本轮不提交、不推送、不建公共仓库。

## 任务 1：交付合同和 CI（RED → GREEN）

文件：tests/ci-delivery.test.ts、scripts/run-browser-ci.mjs、.github/workflows/ci.yml、package.json。

- [x] 添加缺失脚本、工作流安全约束、全量浏览器分组、失败即停止的回归。
- [x] 运行 npm test -- --run tests/ci-delivery.test.ts，确认因交付物缺失失败。
- [x] BROWSER_GROUPS 分为 interface/query/management，getGroup(name) 拒绝未知组；runGroup(name, invoke) 顺序执行，任何失败中止。
- [x] 已配置正式 CI：npm ci、安装 Chromium、全部单测、非增量类型检查、npm run build；三组浏览器回归独立构建且只使用本地夹具。这一勾选代表工作流已编写，不代表远端已执行。
- [x] CI 已配置 verify-query-focus 的 --ready 显式执行与白名单报告收集；本地实际 --ready 回归也已 PASS，没有用默认 WAITING_READY 代替验收。
- [x] 固定版本 actionlint 实际校验工作流，再跑交付合同回归。
- [ ] GitHub 首次 CI 实际运行通过，包括未在本机执行的正式默认构建器。

## 任务 2：公开资料和截图

文件：.github/ISSUE_TEMPLATE/*.yml、CHANGELOG.md、docs/RELEASE-CHECKLIST.md、docs/SCREENSHOTS.md、docs/images/*.webp、README.md、CONTRIBUTING.md。

- [x] Bug/功能/平台适配表单要求先脱敏，不提供粘贴凭据或原始响应的入口。
- [x] 更新日志区分已有历史功能与未发布的本轮交付，不虚构版本发布时间。
- [x] 从 2026-10-05 已通过隔离验收中选浅色、深色、手机界面，人工查看后转为 WebP；保留来源构建 ID 和合成数据说明，不上传整份原始日志。
- [x] README 支持表明确所有模板实站尚未验证，文档/夹具不等同于成功保证。
- [x] 用户已确认 MIT 与 cjmarklll；应用 LICENSE 及 package/lock 许可元数据已添加，不移植上级版权头。

## 任务 3：隔离 Docker 验收脚本（RED → GREEN；容器实测待完成）

文件：tests/docker-delivery.test.ts、scripts/docker-smoke-lib.mjs、scripts/verify-docker.mjs、.dockerignore、docs/DOCKER-VERIFICATION.md。

- [x] 先测严格回环端口解析、随机资源名、白名单构建上下文、秘密文件/链接拒绝、仅清理自身目录和备份秘密排除。
- [x] createDockerContext(root) 只复制 src/public 和明确构建文件，绝不复制部署数据或环境文件。
- [x] 默认命令只显示待执行；--ready 才检查 Docker 并启动验收。缺少 Docker 返回失败结果，不冒充 PASS。
- [x] 已实现随机专属镜像、内部网络、容器和卷；仅发布 127.0.0.1 随机端口及非 root 运行。这里是脚本实现，容器行为仍待实测。
- [x] 已编写合成账户验收断言：仅显式点击等价的 sync 请求访问本地夹具；初始无请求、加密凭据重启仍能查询、数据库+主密钥整卷迁移后能查询、JSON 导出无凭据。这些容器断言尚未实际执行。
- [x] 已实现只清理本次登记且标签归属匹配的资源；禁止 prune 或清理真实卷。精确缺失分类与端口重读已有单测，实际容器清理仍待验证。
- [x] CI 已配置自动运行容器验收；没有实际执行证据前，台账保持未实测。
- [ ] 可用 Docker 环境的完整容器验收 PASS，并人工实测 Compose 部署。

## 最终核验与记录

- [x] 全量单测（开启手势）：记录通过/跳过数。
- [x] 隔离副本非增量 typecheck 和新的生产构建；三组浏览器验收。
- [x] actionlint 与新脚本语法检查；README 链接和三张截图视觉 QA。
- [x] 已实际执行 Docker --ready 预检，记录 BLOCKED / DOCKER_CLI_OR_DAEMON_UNAVAILABLE，未创建资源；此项只代表预检执行，不代表 Docker 验收通过。
- [x] 更新 docs/STATUS.md 和本计划，列出完成项与已确认的 MIT/cjmarklll、待实测 Docker。

## 本轮结论

首轮本地可实施部分完成：711 项测试/0 跳过、类型检查、隔离 webpack 构建 `y8Vw7swW_cLy6JAIl9fvB`、十二套浏览器全部 PASS，actionlint 与文档 QA 通过。实际 --ready 预检已执行并 BLOCKED，没有容器资源。许可证已获用户确认并补入；保留可用 Docker 环境完整实测、Compose 人工实测及首次 GitHub CI 为未完成门槛。不把脚本编写勾选等同容器已经执行，不宣称阶段全部完成，也不开始下一阶段或推送。

## 许可证补全（2026-10-05）

- [x] 用户明确确认 MIT，版权署名 cjmarklll；按标准正文添加 LICENSE，年份采用当前 2026 年。
- [x] package.json 与锁文件根包只补许可元数据，依赖版本、完整性和脚本不变，保留 private=true。
- [x] Docker 隔离上下文白名单和最终非 root 运行阶段显式保留 LICENSE；容器执行仍未验证。
- [x] 三处新断言实际 RED：许可元数据缺失、隔离上下文未复制 LICENSE、运行阶段遗漏 LICENSE。
- [x] 补全后实际 GREEN：24 项交付回归；开启手势的完整单测 39 文件、713 项全部通过，0 跳过；非增量类型检查和 35 处本地文档链接通过。记录于 output/license-2026-10-05/verification.json。本次未重跑构建、浏览器或 Docker，首轮验收证据保持不变。
