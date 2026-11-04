# 文档

## 使用与维护

- [使用指南](user-guide.md)：写作、封面、图库、AI 生图与聊天。
- [架构](architecture.md)：组件、数据归属、可选能力和目录。
- [部署运维](deployment-and-ops.md)：配置、数据库、发布、日志与停机。
- [安全边界](security-boundary.md)：账号、服务间断言、确认及资源访问。
- [前端测试](frontend-testing.md)：TypeScript、浏览器和 CI。
- [依赖维护](dependency-maintenance.md)、[表情资源](sticker-assets.md)。

## 接口与功能契约

- [文章操作](article-actions.md)、[协作编辑](article-collaboration.md)。
- [账号操作](account-actions.md)、[后台目录](admin-catalog-api.md)。
- [通知与信箱](mailbox-api.md)、[个人活动](own-activity-api.md)、[工作队列](dashboard-queue-api.md)。
- [聊天存储](chat-persistence.md)、[审核](moderation-api.md)、[RAG 语料](rag-corpus-api.md)。
- [可选设备集成](iot-device-integration.md)。

Agent 的模型循环、记忆、检索与调度实现以 [Agent 文档](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/README.md)为准，博客只维护宿主业务与接口，不重复描述另一仓的内部实现。
