# 安全问题报告

发现凭据泄露、鉴权绕过、任意文件访问或出站请求限制绕过时，请勿在公开 Issue 中提交利用细节或真实数据。

请通过 [GitHub 私密漏洞报告](https://github.com/sxxso/relaydock/security/advisories/new) 提交，或在仓库的 Security → Advisories → Report a vulnerability 私下报告。该入口已启用；目前未承诺响应时限。普通功能问题使用 Issue 表单。

报告应包含源码版本、受影响功能、预期与实际行为，以及可在本机运行的合成复现。不要附 API Key、Cookie、用户 ID、密码/哈希、`.env`、数据库、主密钥、备份、浏览器状态或原始外站响应。

目前没有稳定发布版本或已承诺维护的历史版本。发布后将在本文件更新支持范围。出现疑似泄露时，先在凭据所属平台撤销或轮换凭据，再处理受影响部署；删除公开文件不能撤销已经暴露的凭据。

项目的实现与验证范围见 [README](README.md) 和 [发布检查清单](docs/RELEASE-CHECKLIST.md)。合成测试通过不代表实际站点、容器、反向代理或 GitHub CI 已验证。
