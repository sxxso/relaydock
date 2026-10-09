# RelayDock 独立开源准备

许可证已确定：MIT，`Copyright (c) 2026 cjmarklll`。独立仓库为 [sxxso/relaydock](https://github.com/sxxso/relaydock)。本页说明如何从应用目录导出独立源码，以及稳定版本发布仍需完成的步骤。`release:prepare` 本身只生成本地候选包，不会自动提交、推送或创建远端仓库。

## 生成可审阅源码

在 RelayDock 应用根目录执行：

```sh
npm ci
npm run release:notices
npm run release:prepare -- --check
npm run release:prepare
```

`--check` 只检查，不写文件；默认导出到新的 `output/open-source/candidate-*/relaydock/`，旁边的 `manifest.json` 记录相对路径、字节数、逐文件 SHA-256 和整体源码指纹。每次生成独立目录，不覆盖旧包。manifest 是本地核对证据，不代表已发布或功能验收通过。

导出白名单包括 src、tests、scripts、public、docs、.github、许可证、环境示例及明确的构建配置。不复制父仓库或历史，也不读取部署的 .env.local、data、主密钥或数据库。嵌套环境文件、数据库及恢复侧车、凭据文件、日志、备份、构建输出和浏览器状态被排除；源目录中的链接/联接被拒绝。未知格式的素材需要人工审阅后才能加入白名单。

内容检查对常见 GitHub/AWS/API 密钥、私钥、个人路径和环境示例生效，发现问题只报告文件名与规则。测试代码中明确标记的合成 API Key 允许保留；代理回归中已有的合成 TLS 私钥仅按固定文件位置和 SHA-256 放行，替换密钥或新增其他私钥仍会阻止导出。模式检查不能证明不存在任何秘密：发布前仍应人工查看整个导出目录和截图，不要以 .gitignore 或自动检查代替审阅。

当前 RelayDock 尚未被上级 Git 仓库跟踪。独立发布应从此导出目录开始，获得自己的初始历史；不要在父技能仓库执行 `git add .`，也不要将父仓库 origin 当作 RelayDock 的发布目标。

## 本地验收

使用导出源码或新的隔离源码构建，保留新的 BUILD_ID 和源码指纹；不要沿用部署的旧 .next，也不要把真实账号作为测试数据。

```sh
npm test
npm run typecheck -- --incremental false
npm run build
npm run ci:browser -- interface
npm run ci:browser -- query
npm run ci:browser -- management
```

本地 Windows 开启全部手势测试的方式见 [贡献指南](../CONTRIBUTING.md)。query-focus、模型表现、签到及邀请脚本必须传 `--ready` 才实际执行；CI 已为这些入口传入该参数。query-focus 同时覆盖最新外观、地图底纹和加载动画。浏览器验收使用合成账号、本机服务和隔离数据库。

## 公开前与正式版本前

- 独立仓库为 `sxxso/relaydock`；更新发布前继续审阅源码与暂存区，勿推送部署文件或旧项目历史。
- Private vulnerability reporting 已启用，入口见 [安全报告说明](../SECURITY.md)。
- 首次 GitHub CI 实际通过，并配置 Core checks、三个 Browser regression、Docker persistence and migration 为必要检查。
- 在可用 Docker 环境完成 `npm run test:docker -- --ready` 和 Compose 实测；当前本机没有可用 Docker。
- 核对依赖安全审计以及 [第三方说明](../THIRD-PARTY-NOTICES.md) 标记的包内原文缺失、跨平台原文和实际容器二进制；源码包不含第三方二进制，Windows 采集不代表 Linux 镜像核对。
- 选定版本标签并整理 Release 说明。package.version=1.0.0 是当前源码元数据，CHANGELOG 的 Unreleased 及 Release 草稿不表示该版本已经发布。

仓库公开、稳定版本发布与实际平台验证分别记录。平台支持仍是夹具范围，用户应在自己的部署中主动测试连接；不要用文档日期或本地 PASS 声称所有实站可用。完整门槛见 [发布检查清单](RELEASE-CHECKLIST.md)。
