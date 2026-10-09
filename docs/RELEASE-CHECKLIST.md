# 独立开源发布检查清单

本文件的勾选代表实际证据，不代表预计完成。各阶段数字为历史验收记录；2026-10-09 的独立源码准备与当前验收见下方、[开源流程](OPEN-SOURCE.md) 和 [当前状态](STATUS.md)。提交、推送与发布另行执行。

## 2026-10-09 独立源码准备

- [x] `release:prepare` 白名单导出、嵌套敏感文件排除、源链接拒绝、内容规则与逐文件 SHA-256 清单；只导出当前应用，不带父仓库历史。
- [x] 忽略本地日志、数据库恢复日志、备份和浏览器状态；public/.gitkeep 保留独立 Git/Docker 所需目录。
- [x] SECURITY.md、公开源码流程与首发说明草稿已补齐，没有虚构私密报告入口或正式版本。
- [x] 第三方生产依赖清单已离线采集：150 个锁定包路径，本机 119 个、可选平台未安装 31 个；本机原文保留在 THIRD-PARTY-NOTICES.md。
- [x] npm 官方生产依赖审计实际返回 0 条已报告漏洞；仅代表本次审计结果，不是无漏洞保证。
- [x] 邀请链接回归纳入 CI 管理分组，十五套浏览器入口全部有分组；CI Core 增加源码公开边界检查。
- [x] 本轮全新源码副本 62 文件/991 项测试、零跳过、非增量类型检查、webpack 主构建 98I14RTUs4NWhxXeTm8uP 与三组共十五套浏览器全部通过。Windows/共享安装依赖的本地范围、额外专项构建和历史失败记录见当前状态；不代表干净安装、Docker 或 GitHub CI。
- [ ] 核对 6 个本机包根目录缺失的许可原文、未安装平台包与实际容器中的二进制及内嵌组件；Windows 声明采集不等于 Linux 分发许可核对。
- [x] `sxxso/relaydock` 公开独立仓库已创建，私密漏洞报告、GitHub secret scanning 与 push protection 已启用；公开源码经过再次隐私复核，新的 Git 历史使用 noreply 身份。
- [x] Ubuntu CI Docker 完整验收实际 PASS：七个检查、三个主动夹具请求、清理错误为零；实际报告见 [Docker 验收](DOCKER-VERIFICATION.md)。
- [ ] Compose 人工实测、必要检查设置与稳定版本标签仍待完成。

## 第一阶段交付

- [x] 工作流及 npm 入口已编写：core、三组浏览器和 Docker 持久化/迁移任务。
- [x] Bug、功能、平台适配 Issue 表单；提交前强制确认不含真实凭据。
- [x] Unreleased 更新日志，以及三张实际界面的合成数据截图。
- [x] 平台夹具、文档和实站验证分开；当前七个平台实站未验证。
- [x] 工作流通过本地 actionlint v1.7.12 校验；新增 YAML 与文档本地链接通过。
- [x] 许可证补全后 24 项交付回归、全部 713 项测试（0 跳过）和非增量类型检查通过。首轮隔离 webpack 构建 `y8Vw7swW_cLy6JAIl9fvB` 与十二套浏览器回归全部 PASS；本次仅补许可证，没有重跑构建/浏览器。远端正式默认构建尚待首次 CI 运行。
- [x] **用户已于 2026-10-05 确认 MIT 与 cjmarklll 署名，应用自身 LICENSE 已添加。** 版权声明 `Copyright (c) 2026 cjmarklll`；package/lock 同步许可，Docker 打包保留声明。不复制上级技能库的版权头。
- [x] **实际 Docker 验收完整 PASS（2026-10-09，Ubuntu GitHub CI）。** 本机 Docker 仍不可用；报告见 [Docker 验收](DOCKER-VERIFICATION.md)。
- GitHub CI 是否完整通过，以[最新提交的全部任务](https://github.com/sxxso/relaydock/actions/workflows/ci.yml)实际结果为准；本地配置或历史成功不能替代最新提交的检查。

## 第二阶段交付

- [x] npm doctor 入口、普通/JSON 白名单结果、production/development 配置优先级及 0/1/2 退出码。
- [x] Node、数据目录权限预检、SQLite 本地驱动/只读快检/必要表结构、管理员、主密钥与全部加密凭据认证、必要部署配置。
- [x] 不联网、不输出秘密、不自动创建/迁移/修复；首次未初始化与未完成检查明确 WARN，现有数据库丢失密钥/认证不匹配明确 FAIL。
- [x] 本轮实际执行 41 文件/784 项合成测试，零跳过；非增量类型、JS 语法、32 份 Markdown/43 处本地链接通过。CLI 断网/副作用阻断与真实 npm 入口均使用合成配置。
- [x] README 入口、[自检说明](DOCTOR.md)、更新日志与状态台账；明确权限预检、WAL、大数据库及备份/密钥边界。
- [x] 两项恢复边界 P2 经 RED→GREEN 修复并复审；7 项独立定向验收通过，无新的具体 P1/P2。机器结果记录于 output/stage2-doctor-2026-10-05/verification.json。
- [ ] doctor 在实际镜像内执行通过；本次 Docker 七项验收未执行 doctor，源码配置不等于该入口已验证。

## 仓库边界与发布

- [x] 用户指定 GitHub 账号 sxxso，仓库名 relaydock；独立公开仓库已创建并推送，使用 GitHub noreply 身份；以应用目录为独立根目录，不带上级技能仓库历史。
- [x] 当前源码通过独立白名单导出；RelayDock 尚无父仓库跟踪历史，候选包不带 Git 历史。实际提交/公开前仍需人工审阅候选包与新仓库暂存区。
- [x] 导出保留 package-lock.json、.env.example、源文件、文档和合成截图；排除 node_modules、.next、output 和本地经验日志。
- [ ] 在 GitHub 设置必要的 CI required checks：Core checks、三个 Browser regression、Docker persistence and migration；不以手工勾选代替检查结果。
- [ ] 第三方依赖声明已采集，缺失原文与最终镜像许可仍需核对；当前视觉为项目文档声明的原创实现，不移植外部品牌原图。
- [x] 撤销、保存视图、备份提示已在后续阶段本地合成验收，参见当前状态；历史性能优化留作后续计划，不宣称已交付。部署自检镜像执行仍待实测。
- [ ] 最终选择版本标签、完成首次提交/推送与 Release，附真实范围和未验证项。

## 不可误导的声明

- 模板存在不代表所有真实站点查询成功；文档审阅日期不代表实站日期。
- JSON 是不含凭据的数据备份；完整迁移还需要数据库、对应主密钥与必要部署配置。
- Docker 脚本存在不代表容器实测通过，CI 文件存在不代表 GitHub CI 已运行。
- package.json 的 private=true 用于避免误发 npm，不妨碍将来经授权发布 GitHub 源码。


