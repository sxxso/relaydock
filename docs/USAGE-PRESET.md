# 余额查询预设：对照 CC Switch

## 自定义 `/v1/usage`

添加或编辑账号时选「自定义余额接口」→「解析预设」→「通用 /v1/usage」。填写接口根地址和 API Key（只填密钥，不加 `Bearer ` 前缀），认证方式选 Bearer Token。接口默认 GET `/v1/usage`；路径可以改为同源接口，不能填另一域名或 URL 参数。

这个声明式预设对应用户提供的脚本：

- 金额依序读取 `remaining ?? quota.remaining ?? balance`。`0` 是有效余额；只有 `null` / 缺失才回退，非法字符串不会跳到下一个字段。
- 单位依序读取 `unit ?? quota.unit ?? "USD"`。非空但非法单位会拒绝结果，不自动换汇。档案单位用于手动记录，不会把接口 CNY 余额改标成 USD。
- 有效状态为 `is_active ?? isValid ?? true`；所选字段必须为布尔 `true`。字符串 `"false"` / `"true"` 等模糊结果也拒绝。
- 原有「自定义字段映射」不变，支持 `(余额字段 - 可选扣减字段) / 除数` 和部署者指定单位。
- 不粘贴/执行任意 JavaScript，不支持多套餐数组、脚本请求体、跨域 URL 或自定义任意请求头。

查询失败、缺字段、账户无效或单位不合法均保留上次成功余额。测试连接不新增余额快照；只有点击刷新成功后记账。

## New API 账户

选择「New API 账户余额」，使用**用户管理访问令牌**而非模型 API Key，填管理根地址与站点要求的用户 ID。请求 GET `/api/user/self`，包含 `Authorization: Bearer …`、`New-Api-User`（填写时）、`Content-Type: application/json`。应用使用自己的 User-Agent `RelayDock-Atlas/1.0`，不冒充 CC Switch。

只有 `success === true` 且 `data.quota` 是合法非负整数才接受。参考脚本使用 500000 配额/USD，但各站点可能不同：只有确认「每单位对应的原始配额」为 `500000`、单位为 USD 后才除以该系数；未确认只显示原始配额。首版记账金额是 remaining，不从 used_quota 推算消费；group/used/total 不被当成余额。

## 代理与故障排查

代理为部署端的可选配置，详见 [查询与网络设置](QUERYING.md)。默认关闭，不读取 Windows 系统代理，不自动启用 DoH。代理不等于远程 DNS：目标仍由部署进程解析、校验并固定到 IP，以保留 SSRF/重绑定防护；系统 DNS 异常需要独立处理，不能用取消安全检查代替。

公开参考：[CC Switch 查询说明](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/zh/2-providers/2.5-usage-query.md)、[查询请求实现](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/usage_script.rs)、[全局 HTTP 客户端](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/http_client.rs)。2026-10-04 查看；上游可能继续更新。这里只参考请求/解析合同，不复用其前端资源，也不提供同等任意脚本运行能力。

本轮验收使用合成响应与本地 CONNECT 代理，不代表任何真实第三方站点已通过。
