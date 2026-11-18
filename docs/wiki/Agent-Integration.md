# 接入 Agent 时核对四条链路

博客提供账号、页面和事务，Agent 提供模型执行。核心博客可以独立运行；
接入教程不意味着给模型宿主登录签名或任意管理权限。

## 身份与服务

Rust 验证登录后签发短期身份，双方的断言密钥一致；工具委托由 Rust 签发，
Agent 转发使用，不持有其签名密钥。确认卡使用 Agent 独立密钥。
模型与 Agent 状态库单独配置，浏览器不直接访问内部 Agent 端口。

## 静态组件

看板娘源码在 Agent 仓，本仓通过 widget.lock 固定提交和资源子树。
组件先 fetch，再 vendor Live2D。不要直接修改博客内拉取的副本。
只改 Python 不要求更新组件锁，更新组件也不证明 Python 服务已升级。

## 业务读写

先在开发环境验证只读文章请求，再验证准备、批准、取消与版本冲突。
卡片出现只表示提议，真实写入仍由宿主检查权限和业务版本。
全文总结的覆盖由 Agent 管理；宿主提供有版本的公开原文，不扩大到私有语料。

## 页面回报与后台

导航、外观与编辑器动作等待有界浏览器回报，回报不授予账号权限。
后台计划还需独立 Worker 和有限委托，普通聊天断连不能当成后台持续执行。

接入配置见[配置导航](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/docs/configuration.md)，
契约见[聊天存储](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/docs/chat-persistence.md)与
[安全边界](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/docs/security-boundary.md)。
模型和任务使用见[Agent Wiki](https://github.com/BigLeopardCat/saudade-blog-agent/wiki)。
