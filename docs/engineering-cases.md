# 工程案例：业务宿主与交付边界

[English](en/engineering-cases.md) · [文档导航](README.md)

本文解释博客侧的实现取舍。Agent 的全文总结、执行账恢复与评测案例见[配套工程案例](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/engineering-cases.md)。不将这些设计描述当作当前线上性能或发布成绩。

## 1. Agent 改稿不能覆盖作者的并发编辑

作者可能已经在编辑器修改正文，而 Agent 仍基于旧快照提出润色。无条件替换会丢本地工作，直接保存又把建议、采纳和业务写入混为一谈。

因此区分浏览器工作副本、已存草稿和发布版本。Agent 提案经编辑器审阅采纳，按对应基线/版本检查适用性；保存与发布继续走宿主原有流程和乐观版本条件。看到编辑页不授予权限，发出客户端命令不表示已执行。

客户端回报区分 completed、failed、timeout 和 unknown。编辑器完成回报只证明工作副本动作，宿主保存回执才证明持久化。正文、标题协作与文章摘要的确认入口不同，不强行归为同一个自动保存路径。

审阅和冲突处理增加交互，但避免静默覆盖。正确展示差异也不证明改稿质量，内容仍需审核；已采纳不等于已保存，更不等于已发布。

实现入口：[编辑器](../frontend/src/pages/Dashboard/Notes/NewNotes/index.tsx)。规范：[协作编辑](article-collaboration.md)、[文章操作](article-actions.md)、[安全边界](security-boundary.md)。验证按[前端测试规范](frontend-testing.md)和[代码导读](code-reading.md)分别检查界面回报、API 版本冲突及真实数据库，不能用合成浏览器接口证明生产已保存。

## 2. 宿主、运行时和组件独立固定版本

Python 升级不一定修改看板娘，组件修改也不一定需要新运行时。从相邻目录任意取源码会把旧检出或未提交改动引入结果，无法复现兼容组合。

Agent 的 host-contract 固定公开宿主测试源码；博客的 widget.lock 固定组件源提交及两棵子树哈希；Compose 的 agent.lock 独立固定运行时源码。只在采用对应变化时更新，引用已推送可获取的完整提交，不为追赶 HEAD 机械改 pin。

发行包记录准确源码、manifest 和校验值。CI 在可丢弃环境验证安装、配置复用、数据库及上传还原；原生包注明平台/ABI，容器归档保存验证过的组合。工作机同时是生产机，完整编译与恢复演练交给 CI。

代价是需要明确配套版本与跨层发布顺序，收益是文档或 Python 改动不会无故替换组件。SSE、鉴权或客户端操作改变时仍必须检查 Rust、Python、浏览器三端。pin、主线提交和 CI 成功都不能替代实际版本核对：前端 build-info、后端产物来源和 Agent `/version` 分开确认。

入口：[兼容与升级](compatibility-and-upgrades.md)、[组件锁](../frontend/widget.lock.json)、[运行时锁](../deploy/docker/agent.lock.json)、[打包工具](../deploy/package_release.py)、[容器演练](../.github/workflows/container.yml)。安装恢复通过不证明长期可用性，验证范围、未测项和部署状态需单独记录。
