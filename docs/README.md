# 文档导航

[English technical guide](en/README.md) · 中文文档

使用发行版时在对应 tag 下查阅文档；主线说明不证明生产已经部署。
博客负责业务数据、权限、事务与页面；Agent 负责模型执行、运行记忆和调度。

## 从哪里开始

| 目标 | 入口 |
| --- | --- |
| 写作、图库和聊天操作 | [使用指南](user-guide.md)、[Wiki 场景教程](wiki/Home.md) |
| 安装一个站点 | [安装入口](../deploy/README.md) → [预构建安装](../deploy/prebuilt.md) |
| 准备发行包 | [发行维护](../deploy/releasing.md) → [兼容与升级](compatibility-and-upgrades.md) |
| 理解代码或参与开发 | [架构](architecture.md)、[代码导读](code-reading.md)、[CONTRIBUTING](../CONTRIBUTING.md) |
| 处理配置和故障 | [配置导航](configuration.md)、[部署运维](deployment-and-ops.md)、[排障](troubleshooting.md) |

## 设计、开发与运维

| 文档 | 负责解释 |
| --- | --- |
| [架构](architecture.md) | 系统边界、组件职责、请求时序、数据归属及可选能力 |
| [代码导读](code-reading.md) | 请求鉴权、编辑保存、Agent 代理与事务的入口 |
| [使用指南](user-guide.md) | 当前界面的版本化操作说明 |
| [配置导航](configuration.md) | 必需配置、可选能力、配置归属及启用条件 |
| [兼容与升级](compatibility-and-upgrades.md) | 组件、宿主、Agent、数据库的发布顺序与运行版本 |
| [部署运维](deployment-and-ops.md) | systemd、迁移、发布、日志、备份和回滚 |
| [排障](troubleshooting.md) | 实际版本、跨仓故障、图片与写入未知结果 |
| [安全边界](security-boundary.md) | 身份、委托、签名、确认和资源授权 |
| [前端测试](frontend-testing.md) | 类型、组件、浏览器与合成数据边界 |
| [依赖维护](dependency-maintenance.md) | 锁文件、审计和兼容升级 |
| [表情资源](sticker-assets.md) | 资源制作与分发规范 |
| [教程截图](screenshots.md) | 可复现的截图来源、文件名、插入位置与更新方式 |

## 业务接口契约

| 领域 | 文档 |
| --- | --- |
| 文章 | [首页文章流](public-feed-api.md)、[文章操作](article-actions.md)、[协作编辑](article-collaboration.md) |
| 管理 | [账号操作](account-actions.md)、[后台目录](admin-catalog-api.md)、[审核](moderation-api.md) |
| 个人数据 | [通知与信箱](mailbox-api.md)、[个人活动](own-activity-api.md)、[工作队列](dashboard-queue-api.md) |
| Agent 接入 | [聊天存储](chat-persistence.md)、[RAG 语料](rag-corpus-api.md)、[安全边界](security-boundary.md) |
| 可选设备 | [设备接口集成](iot-device-integration.md)，不包含固件开发教程，也不是安装前置条件 |

## 文档归属

[README](../README.md)保留定位与起步，[CONTRIBUTING](../CONTRIBUTING.md)维护协作和验证，
[deploy](../deploy/README.md)负责安装与部署命令，[Wiki 源稿](wiki/Home.md)按场景编写教程。
接口、默认值和迁移要求留在仓库随版本维护，Wiki 链接这些规范，不再复制一套配置表。
[路线图](../ROADMAP.md)表示未来工作，不作为当前能力证明。

Agent 的内部原理和扩展见[Agent 文档](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/README.md)，
使用助手见[Agent Wiki](https://github.com/BigLeopardCat/saudade-blog-agent/wiki)。博客不重复维护模型循环与检索算法说明。

## 工程案例

[关键问题与设计取舍](engineering-cases.md)提供中英文案例，链接当前代码、验证入口及限制；不是开发流水账或新的发布报告。
