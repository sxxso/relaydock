# Docker 验收

**当前状态（2026-10-05）：本机没有 Docker CLI / 可用 daemon，尚未容器实测。** Dockerfile、Compose、自动验收脚本或安全边界单测不等于镜像已验证；GitHub CI 任务也只有实际成功运行后才算证据。

## 执行条件

安装并启动 Docker Engine / Docker Desktop；Node.js 22.20+。脚本只用 Node 内置模块，在应用根目录执行，不要求先 npm ci。构建需要访问镜像仓库、系统软件源和 npm 注册表，这些是获取依赖，不是余额查询供应商。

```sh
# 仅显示待执行说明，不创建容器或写数据
npm run test:docker
# 明确允许构建与专属临时资源验收
npm run test:docker -- --ready
```

## 验收范围

1. 白名单复制 src/public、应用 LICENSE 与明确的构建文件；不读取或复制 .env.local、data、数据库、主密钥、node_modules、现有 .next 或源文件链接。
2. 构建新镜像，创建随机命名且带运行标签的专属容器/卷/内部网络。应用和余额夹具只连接内部网络；单独的只读、无额外 capabilities 的 TCP 转发容器连接内部网络与本次入口网络，只映射 127.0.0.1 随机端口。内部网络本身不发布主机端口，参见 [Docker 上游记录](https://github.com/moby/moby/issues/36174)。应用保持非 root，运行阶段显式复制 LICENSE 至 /app/LICENSE（此配置仍待容器实测）。
3. 用随机合成密码登录，新增合成账号；登录与保存均不发余额请求。
4. 仅主动 sync 请求查询本次内部网络中的合成 HTTP 服务，没有真实平台、真实凭据、自动轮询或出站余额查询。
5. 重启原容器后读取原余额，再次主动查询，验证持久化凭据和主密钥仍可使用。
6. 停止原应用，将整个数据卷复制到本次创建的新卷，再运行独立容器；再次登录、读取和主动查询，验证数据库+主密钥迁移。
7. JSON 数据备份不含密码、查询凭据、管理员哈希、会话或主密钥；三个主动查询对应三个快照。
8. 按固定名称与运行标签校验后，只清理本次资源和拥有的构建上下文；不 prune、不遍历用户容器、不删除真实数据卷。镜像构建缓存不做全局清理。

## 结果与发布门槛

`output/docker/verification.json` 只记录状态、检查名称、镜像标识、版本、请求计数及清理结果，不保存密码、凭据、环境文件或原始日志。

- `PASS` / 退出码 0：全部检查及清理成功，`dockerVerified=true`。
- `BLOCKED` / 直接 Node 退出码 2（npm 包装仍返回非零）：Docker CLI 或 daemon 不可用，不创建验收资源。
- `FAIL`、`CANCELED` / 非零：某阶段或清理失败，`dockerVerified=false`。不将已有成功检查当成整体通过。

CI 自动执行同一 --ready 命令。只有取得实际运行的完整 PASS 报告后，才更新本文与发布检查清单。现有 Compose 的人工启动还应依 README 验证；本脚本不接管已有 Compose 项目。

本轮已执行 --ready 预检，报告明确 BLOCKED，没有启动容器。端口重读、精确资源缺失分类及其他安全边界已有单测，并补入许可证复制与运行阶段声明回归；这些不是 Docker 实测证据。

## 本地部署自检入口

第二阶段新增 doctor，可在镜像中执行 node scripts/doctor.mjs --json，或停止服务后通过 Compose 临时容器检查同一数据卷。脚本不会初始化或修复数据，非空 WAL 保留 WARN。详见 [本地部署自检](DOCTOR.md)。运行阶段文件与白名单已经接入，但 doctor 在容器内执行也尚未实测，不改变本文的 Docker 未验证状态。
