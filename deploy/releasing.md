# 博客发行维护

适用于准备 GitHub Release 和预构建附件的维护者。安装者从[预构建安装](prebuilt.md)开始。

## 构建、校验与发布

准备构建前冻结宿主完整提交、`deploy/docker/agent.lock.json` 和 `frontend/widget.lock.json`。
核对 manifest 的 `source_revision`、`agent_revision`、`widget_revision` 与候选组合，
并核对草稿目标、tag 和附件校验值。独立 Agent 服务的 `/version` 只反映该实例。

`PostgreSQL container` 工作流验证可选 Agent/Worker、首次登录、配置复用、数据库/上传恢复、
核心博客独立安装和非 root nginx。手动构建传入 `package_images=true`，从同一批验证过的镜像
提取原生文件及可导入镜像。传入 `release_tag` 时只附加到完整提交与构建一致的已有草稿。
任何版本变更都重新构建附件。依赖审计独立核对，保留 [审计结论](../docs/dependency-maintenance.md)
及适用迁移、已知限制和回滚步骤随版说明。

配套锁的更新范围、升级和回退见[兼容与升级](../docs/compatibility-and-upgrades.md)。已经部署的系统按[运维手册](../docs/deployment-and-ops.md)核对实际运行版本。
