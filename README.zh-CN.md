# Saudade Blog

[English](README.md) · 简体中文

可独立部署的个人博客与内容管理应用，覆盖写作发布、阅读检索、图库和站内互动；可选接入 Agent 协作与 AI 生图。

后端使用 **Rust / Axum / SeaORM / PostgreSQL**，前端使用 **React / TypeScript / Vite**。业务数据、权限和事务由博客管理，模型执行由独立的 [Saudade Blog Agent](https://github.com/BigLeopardCat/saudade-blog-agent) 提供。

[在线博客](https://saudade.site/) · [使用指南](docs/user-guide.md) · [部署](deploy/docker/README.md) · [架构](docs/architecture.md) · [版本发布](https://github.com/BigLeopardCat/Saudade-Blog/releases)

在线站点展示实际部署；后台管理和协作编辑需要管理员身份。

公开页面与对话框支持中英文界面切换，记住用户选择并同步其他标签页；文章、分类名称和用户内容保留原文。后台管理尚未完整翻译。

## 从这里开始

| 我想做什么 | 入口 |
| --- | --- |
| 阅读、写作、用图库或和看板娘对话 | [使用指南](docs/user-guide.md) · [任务教程](docs/wiki/Home.md) |
| 安装或维护站点 | [部署入口](deploy/README.md) · [配置](docs/configuration.md) · [兼容与升级](docs/compatibility-and-upgrades.md) |
| 看懂系统或改代码 | [系统架构](docs/architecture.md) · [代码导读](docs/code-reading.md) · [贡献指南](CONTRIBUTING.md) |

核心博客可独立部署。Agent、AI 审核、生图、R2 和 IoT 按需要接入。[可选能力](docs/architecture.md#可选能力)

## 安装与发布验证

从 [最新发行版](https://github.com/BigLeopardCat/Saudade-Blog/releases/latest) 获取 Linux amd64 容器归档或原生安装包。按[预构建安装指南](deploy/prebuilt.md)校验 SHA256SUMS，再按 manifest 固定的版本安装。容器安装需要 Docker Engine 与 Docker Compose 2.30+。

默认安装核心博客并绑定回环地址。公开域名、TLS、首个管理员及可选 Agent 按[容器指南](deploy/docker/README.md)配置。现有 systemd 实例按[部署和升级指南](docs/deployment-and-ops.md)操作。

[公开 PR 检查](https://github.com/BigLeopardCat/Saudade-Blog/actions) 验证 Rust、临时 PostgreSQL、前端类型与组件、Playwright 浏览器，以及容器安装、备份恢复与失败回退。仅博客安装和启用 Agent 的组合分别验证，不依赖维护者服务器或私有密钥。浏览器测试使用真实组件和合成接口数据；隔离验收不等于真实流量表现或所有线上操作已经完成。

配套 Agent 的模型任务通过率、缓存与时延见 [Agent 发布证据](https://github.com/BigLeopardCat/saudade-blog-agent/releases)；这些指标不代替博客自身的功能与部署验收。

## 开发起步

需要 Rust 1.92+、Node 24.22.1（见 `.node-version`）和 PostgreSQL 16。

```sh
git clone https://github.com/BigLeopardCat/Saudade-Blog.git
cd Saudade-Blog
cp .env.example .env
```

创建开发数据库与应用角色，按[开发指南](CONTRIBUTING.md)应用 PostgreSQL 基线及编号迁移。填写 `DATABASE_URL`、随机 `JWT_SECRET` 和本站地址，再启动：

```sh
cargo run
```

另开终端运行前端：

```sh
cd frontend
npm ci
npm run fetch:widget
npm run vendor:live2d
npm run dev
```

看板娘源码在 Agent 仓库；本仓通过 `frontend/widget.lock.json` 固定提交与子树哈希。组件下载先于 Live2D vendor 准备，构建缺失资源时应失败。

## 文档

[使用指南](docs/user-guide.md) · [Wiki 教程](https://github.com/BigLeopardCat/Saudade-Blog/wiki) · [文档索引](docs/README.md) · [配置](docs/configuration.md) · [代码导读](docs/code-reading.md) · [排障](docs/troubleshooting.md)

界面、接口、配置与运维说明随源码维护；Wiki 按写作、图库、安装与恢复组织教程，
[源稿](docs/wiki/Home.md)随 PR 评审。截图使用合成数据，不包含真实账号、私信与密钥。

## 贡献与许可

提交采用 `type(scope): 中文说明`，完整检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。后续方向见 [ROADMAP.md](ROADMAP.md)，用户可见变化见 [CHANGELOG.md](CHANGELOG.md)，安全问题见 [SECURITY.md](SECURITY.md)。

博客代码按 [GPL-2.0](LICENSE) 分发，来源与第三方声明见 [THIRD-PARTY.md](THIRD-PARTY.md)。Agent 聊天组件代码使用 MIT，角色及美术资源另有许可，见 [Agent 资源许可](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/frontend/ASSETS-LICENSE.md)。

英文技术入口见 [English guide](docs/en/README.md)，工程案例见[中文案例](docs/engineering-cases.md)与[English cases](docs/en/engineering-cases.md)。
