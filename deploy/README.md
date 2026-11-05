# 部署入口

部署要求、数据库迁移、配置、日志、停机及回滚见[部署与运维](../docs/deployment-and-ops.md)，不在此重复维护参数表。

- `install.sh`：服务器安装辅助脚本。运行前审阅其账号、路径和可选服务；已有部署先备份，不能把空库初始化当作升级。
- `systemd/`：服务模板，安装前替换实际用户和路径。
- [独立服务账号](service-isolation.md)：Rust、Agent、后台任务的账号隔离、可写状态、验收和回滚。
- `nginx/`：反向代理模板，按站点证书和资源路径核对。
- `docker/`：未支持的容器草案，不可用于当前 PostgreSQL 版本。

常规发布由 GitHub Actions 构建固定提交，经 R2 交付服务器。公开 PR 只检查，不部署、不接触生产凭据。

Agent 使用独立版本发布，入口为 `agent.main:app`，见 [Agent 部署](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/deployment.md)。不要从业务开发 checkout 启动线上进程。
