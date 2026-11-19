# 博客与 Agent 的兼容和升级

确定要更换的是宿主后端、浏览器组件、独立 Agent，还是发布包内的 Compose Agent。每次只变更有需要的对象，按本次涉及的契约决定验证和切换顺序。

## 版本从哪里查

| 对象 | 构建或测试依据 | 运行时依据 |
| --- | --- | --- |
| 博客前端与 Rust 后端 | 博客发行 manifest 的 `source_revision` | 前端 `/build-info.json`，Rust 实际进程加载的产物及其出处 |
| 看板娘 | 博客 `frontend/widget.lock.json` 固定组件提交和两棵资源子树 | 前端构建使用的锁及实际加载的组件资源 |
| Compose Agent | 博客 `deploy/docker/agent.lock.json` 与发行 manifest 的 `agent_revision` | 容器内 Agent `/version` 和实际进程 |
| 独立 Agent | Agent 发行 manifest 与用于服务启动的固定提交 | Agent `/version` 和 HTTP、调度进程的实际发布目录 |
| Agent 测试使用的宿主 | Agent `.github/host-contract.json` | 用于 CI 取回宿主接口源码。线上宿主从自己的运行状态核对 |

发布包之间的已验证组合以对应 Release 的 manifest 和检查记录为依据。例如博客 v0.3.0 的 Compose 包固定 Agent v0.3.1。独立安装的 Agent v0.3.2 有自己的包和部署状态。其他组合按受影响契约验证，再登记为已验证。[博客 v0.3.0](https://github.com/BigLeopardCat/Saudade-Blog/releases/tag/v0.3.0) · [Agent v0.3.2](https://github.com/BigLeopardCat/saudade-blog-agent/releases/tag/v0.3.2)

## 按改动范围选择升级顺序

| 改动 | 升级前核对与顺序 | 回退与上线核验 |
| --- | --- | --- |
| 仅更新看板娘 | 推送可取回的组件提交。确认它兼容当前宿主接口，再更新博客组件锁、构建并部署博客前端。 | 还原上一个兼容的前端构建，核对浏览器实际下载的组件资源。 |
| 独立 Agent 补丁 | 检查当前宿主契约、状态库及可选 Worker。准备固定版本后，按 Agent 部署流程切换 HTTP 服务及已启用的 Worker。 | 按同一流程回退到兼容提交，检查就绪、`/version` 与两个实际进程。 |
| 更新 Compose Agent | 更新博客的 Compose Agent 锁，使用该组合的安装、升级、恢复及跨仓契约检查验证。 | 按容器指南切换回兼容组合，继续使用已有状态和卷。 |
| SSE、身份、确认或客户端回报变更 | 在配套 PR 写明旧宿主、新 Agent 和缓存中的旧组件如何交互。先部署仍兼容现网的接收端，再启用发送端。双方无法兼容时协同切换，并验证失配能被安全拒绝。 | 以经过验证的配对组合回退，核对消息、签名、确认与业务回执。具体顺序随契约变更确定。 |
| 数据库变更 | 先备份业务库、持久上传和私有配置。在隔离库验证增量迁移及新旧程序兼容性，再按变更要求执行适用迁移并切换服务。 | 应用代码和数据库分别考虑回退。旧程序不兼容新 schema 时使用已验证的恢复路径。 |

- [容器升级与回滚](../deploy/docker/README.md#升级与回滚)
- [原生服务及数据库运维](deployment-and-ops.md)
- [Agent 独立部署与回滚](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/deployment.md#升级与回滚)
- [SSE 协议兼容规则](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/chat-stream-protocol.md#发布衔接)
