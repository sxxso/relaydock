# 特效配色、邀请链接、几何加载与底图可行性

日期：2026-10-08。此文件保留初始候选设计。用户已批准外观、底图及 New API 邀请功能，并明确排除 Sub2API；实施状态见 [当前实施记录](2026-10-08-appearance-aff-implementation.md)，用法见 [外观](../APPEARANCE.md) 和 [邀请链接](../INVITATION.md)。没有请求真实站点、读取真实凭据或更新运行部署。

## 特效配色

现状：`src/components/ink-canvas.tsx` 读取 `--ink-decoration`，浅深主题值分别为 `189,73,53`、`217,117,94`，定义在 `src/app/globals.css`。设置目前只有主题、装饰动效开关和底图。

建议在外观设置增加“特效颜色”：跟随主题、海蓝、青绿、琥珀、紫色和自定义颜色；支持透明度预览与恢复默认。只影响装饰墨迹，保留错误/余额告警的语义颜色。选择值持久化，并同步当前 Canvas，不依赖窗口 resize 才生效。继续遵守减少动效、触屏禁用擦显及拖动时立即清空规则。

## 邀请链接

New API 上游：`GET /api/user/aff` 返回邀请码，`GET /api/user/self` 也含 `aff_code`。使用用户管理认证；模型 Key 不等于管理 PAT。缺少邀请码时 GetAffCode 会生成并保存，不能当作完全无副作用的读取。

Sub2API 已按用户要求排除，本轮不新增 provider、JWT 配置或邀请接口。下方 Sub2API 链接仅为初始可行性研究来源。

账号详情增加独立 New API 邀请区，展示邀请码、完整链接、获取时间，以及获取/复制/手动编辑。点击获取时告知缺码可能生成；按账号缓存，保留同域多账号，手动值与自动值分别标记；定制注册路径允许覆盖。缺失/失效凭据、404、HTML 页面明确分类。当前 New API 上游默认注册页为 `/sign-up`；旧版或定制入口使用自定义注册地址。

上游证据（2026-10-08 浏览核对；实际站点可能为旧版本或改版）：

- https://github.com/QuantumNous/new-api/blob/main/router/api-router.go
- https://github.com/QuantumNous/new-api/blob/main/controller/user.go
- https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/user.go
- https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/user_handler.go
- https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/affiliate_service.go
- https://github.com/Wei-Shaw/sub2api/blob/main/frontend/src/views/user/AffiliateView.vue
- https://github.com/Wei-Shaw/sub2api/blob/main/frontend/src/api/client.ts

## 几何加载

现状：`workspace-loading.tsx` / `.css` 提供工作台骨架与方形组合，`interaction-motion.css` 控制旋转、移动、刻度伸缩。

推荐“方形→菱形→圆形→群岛组合”的短循环；替代方案为三种几何图形拆解重组，或折纸展开。采用 CSS/SVG 变换，保留布局骨架，真实数据准备完毕即结束，不人为延迟启动；减少动效模式显示静态组合。颜色与装饰配色协调，启动设置读取前有确定的默认图形，避免闪烁。

## 地图底图

现状：已有素纸、点阵、方格、十字坐标、等高线五种，可在设置和地图直接切换。

候选方案：

| 方案 | 画面 | 适用 |
| --- | --- | --- |
| 疏朗海图（推荐） | 大间距坐标标记、少量海流曲线、极淡纸纹 | 延续群岛主题且易读 |
| 精简等高线 | 线条更疏，缩小后降低细节，避免明显平铺接缝 | 强化地图感 |
| 几何测绘纸 | 主辅刻度和低对比网格，缩放时调整密度 | 布局整理和对齐 |

优先让底图浓度和纹理密度可调。使用可平铺静态 SVG，支持负坐标并跟随相机；背景无需持续动画循环，文字和群岛维持前景层次。新增背景先用合成站点对照浅深主题、手机、远近缩放后决定默认项。

实施顺序：特效配色与几何加载 → 底图对照预览 → New API 邀请接口。验收需要设置重载、Canvas 配色、减少动效、地图手势与负坐标回归，以及独立合成邀请响应验证；真实站点能力尚未验证。
