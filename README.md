# Saudade Blog

个人博客与内容管理应用。Rust / Axum / SeaORM / PostgreSQL 提供业务服务，React / TypeScript / Vite 提供阅读、管理与编辑界面。可选接入独立的[博客 Agent](https://github.com/BigLeopardCat/saudade-blog-agent)。

## 功能

- Markdown 写作、公式与 Mermaid、文章分类标签、封面展示及草稿版本管理。
- 聚合搜索与可选文章向量图谱、评论、收藏、公告、个人通知和站内信。
- 图库默认本地存储、可选 R2，支持文件夹、预览、收藏、元数据管理和跨存储移动/复制；管理员 AI 生图先审提示和参考图，再审结果入库。
- 看板娘对话、站内工具与管理员协作编辑，写操作由服务端校验与人工确认。
- 河灯留言、主题与阅读设置；IoT 演示为可选集成。

博客核心功能可独立运行。未安装 Agent 时，聊天、AI 审核和向量服务等可选能力不可用，不应影响文章阅读、管理与普通业务。可选能力失败须如实反馈，不能伪装成空数据或成功。

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

## 安装部署

新环境可用 [PostgreSQL 一键安装与 Docker Compose](deploy/docker/README.md)，默认安装核心博客，Agent 和计划任务可选。现有 systemd 实例继续使用[固定版本发布流程](docs/deployment-and-ops.md)。

## 文档

[使用指南](docs/user-guide.md) · [文档索引](docs/README.md) · [架构](docs/architecture.md) · [开发](CONTRIBUTING.md) · [部署运维](docs/deployment-and-ops.md) · [安全边界](docs/security-boundary.md)

短使用步骤与版本相关说明随源码维护；更长的场景教程可放 Wiki 并链接这些文档。截图使用合成数据，避免包含真实账号、私信与密钥。

## 贡献与许可

提交采用 `type(scope): 中文说明`，完整检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。后续方向见 [ROADMAP.md](ROADMAP.md)，用户可见变化见 [CHANGELOG.md](CHANGELOG.md)，安全问题见 [SECURITY.md](SECURITY.md)。

博客代码按 [GPL-2.0](LICENSE) 分发，来源与第三方声明见 [THIRD-PARTY.md](THIRD-PARTY.md)。Agent 聊天组件代码使用 MIT，角色及美术资源另有许可，见 [Agent 资源许可](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/frontend/ASSETS-LICENSE.md)。
