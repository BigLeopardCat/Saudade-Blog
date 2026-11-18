# 代码导读

先读[架构](architecture.md)确认数据归属，再追踪一个请求如何经过身份、业务事务和页面状态。
本仓负责宿主；Agent 的模型循环和 checkpoint 在另一仓，不在本仓复制实现。

## 从浏览器到业务 API

| 入口 | 阅读问题 |
| --- | --- |
| [main](../src/main.rs)、[routes](../src/routes/mod.rs) | 启动了哪些资源，路由和认证如何装配？ |
| [auth_jwt](../src/auth_jwt.rs)、[authz](../src/authz.rs) | 登录、令牌代次、冻结状态与当前角色在哪里校验？ |
| [entity](../src/entity/mod.rs)、[迁移清单](../scripts/migration/pg/ci_schema_files.py) | 字段与索引如何演进，哪些迁移不进入普通初始化？ |
| [lifecycle](../src/lifecycle.rs) | 停机时如何等待已接受任务，何时停止准入？ |

## 编辑与发布

从[文章编辑页面](../frontend/src/pages/Dashboard/Notes/NewNotes/index.tsx)定位工作副本、自动保存与发布入口，
对照[协作契约](article-collaboration.md)区分原文、草稿、编辑器版本和 Agent 提议。
检查冲突如何拒绝旧保存，浏览器采纳如何与数据库提交区分。

## Agent 代理与写入

读[聊天入口](../src/routes/chat.rs)、[存储契约](chat-persistence.md)与[安全边界](security-boundary.md)。
请求先验证账号和会话归属，宿主签发有限断言及工具委托；客户端不持有签名密钥。
SSE 收到正文不等于数据库已保存，done 的完成边界要与实际保存结果一起核对。

以[公告事务](../src/routes/announcement_actions/mod.rs)和
[稳定操作入口](../src/routes/announcement_actions/operations.rs)为例，追踪操作编号、版本、
公告、个人通知与历史回执的事务边界。重复请求先返回旧回执，不能因资源后来删除又重新创建。
普通赋值看似幂等，也要核对附带通知是否会重复。

## 找到验证证据

Rust/数据库测试、前端组件测试和浏览器拦截测试回答不同问题，见
[前端验证](frontend-testing.md)与[CONTRIBUTING](../CONTRIBUTING.md#4-验证)。
先找业务事实的断言，再看模型或界面文案。维护机不跑完整编译和构建；用 CI 验证完整矩阵。
排障和运行版本核对见[排障](troubleshooting.md)。
