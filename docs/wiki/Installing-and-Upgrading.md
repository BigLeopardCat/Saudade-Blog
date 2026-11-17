# 安装与升级的顺序

新装与已有站点升级是不同流程。核心博客不要求 Agent、模型或 R2；
先选择需要的功能，再生成私有配置，不因看到可选字段就全部启用。

## 新安装

1. 在构建机或 CI 准备已审查的干净源码。低内存生产服务器不承担完整镜像编译。
2. 按[容器首次安装](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/deploy/docker/README.md#首次安装)选择站点地址、TLS 与功能组合。
3. 审阅私有配置和首次管理员文件。初始账号仅在空用户表创建；已有账号不通过重跑初始化接管。
4. 启动后核对就绪、站点来源、管理员登录、文章与原图，再启用需要的可选能力。

模型密钥通过私有文件提供，不放命令行或镜像。初次登录后更换初始密码。
需要 Agent 时在首次准备前选择相应方案；后续追加按专门步骤操作，不重建博客库。

## 升级与回滚

记录实际版本，备份数据库、上传内容和私有配置，先在隔离环境核对恢复。
审查新增编号迁移，再按对应部署流程选择完整提交。已有数据库不重跑基线，
镜像升级命令也不替代数据库迁移。

分别核对博客 build-info、后端产物和 Agent 版本，不能用锁文件推断全部组件已经升级。
回滚先确认 schema 向后兼容；不兼容时停写并走备份恢复，不让旧程序直接使用不兼容结构。

命令只在规范入口维护：
[容器升级与回滚](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/deploy/docker/README.md#升级与回滚)、
[原生部署运维](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/docs/deployment-and-ops.md)。
