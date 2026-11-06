# 仓库协作规则

本文件供各编码助手和会话共享；具体开发、测试和提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 工作区与交接

- 开始前核对仓库根、当前分支、`git status --short` 和 `git worktree list`；本机 checkout 可能落后于远程或正在被其他会话使用。
- 用户指定的提交或配套 PR 优先作为基线；否则从更新后的 `origin/cn_sora_blog` 创建独立 `codex/` 分支和工作树。
- 只暂存本任务文件。保留其他会话的未提交改动，不批量 restore/reset、清理工作树、改写共享分支或更改全局 Git 配置。
- 发布前检查远程分支的新提交，合并时保留双方功能并验证冲突涉及的行为；不要用覆盖文件或强推解决并行开发冲突。
- 交接记录仓库、基线、远程分支、完整 commit、PR、该提交的验证结果、配套仓库版本和剩余工作。分开说明已推送、已合并及实际部署状态。

- 修改文件时一并检查注释和文档字符串，清理过时迁移说明、开发过程记录、重复解释和失效指引；保留当前设计取舍、权限与事务边界、协议约束。
- 注释清理后核对有效语法和相关测试，保留装饰器、属性、测试标记、许可和业务测试输入。

## 跨仓边界

- 本仓维护 Rust、博客前端及宿主 API；Agent 是独立 Git 仓库，按它自己的 AGENTS.md 和 CONTRIBUTING.md 工作。
- 看板娘源码在 Agent 仓的 `frontend/public/live2d-widgets` 和 `frontend/public/live2d_model`；本仓副本由 `frontend/widget.lock.json` 拉取，不直接编辑。
- SSE、身份委托、确认、任务控制或客户端操作改变时，同时核对 Rust、Python 和组件；配套 PR 写明兼容与发布顺序。
- 组件锁只固定前端子树；Agent 的 `.github/host-contract.json` 固定宿主测试源码，两者用途不同。没有相关契约或资源变化时，不为追赶 HEAD 更新锁文件。
- 锁文件只引用已推送、可取回的完整提交与真实子树哈希。`fetch:widget` 先于 `vendor:live2d`。

## 验证与运行环境

- 维护者的工作机同时是生产服务器。不在该机运行 `vite build`、`cargo build --release`、`cargo clean` 或全量 Rust 编译/测试；完整构建交给 CI，选择有资源边界的定向检查。
- 开发工作树不是生产发布目录；不能因本地 HEAD 或 CI 绿灯推断已上线。分别核对前端 build-info、后端二进制产物出处及 Agent `/version`。
- 开发与 CI 使用独立配置和可丢弃数据库；普通验证不调用付费模型、不向生产写入。
- 运行账号只读代码、写自己的状态；部署账号负责发布。凭据留在私有运行配置，权限与发布流程见 [部署与运维](docs/deployment-and-ops.md) 和 [账号隔离](deploy/service-isolation.md)。
- 文档保留当前职责、契约和操作步骤；源码注释只解释必要约束，不追加历史叙事或一次性总结文档。
