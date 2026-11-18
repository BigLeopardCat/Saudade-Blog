# 部署入口

已有发行版可选择[预构建快速安装](prebuilt.md)，跳过 Rust 和前端编译；先核对平台、版本与校验值。

新环境使用 [Docker Compose 安装指南](docker/README.md)：`install.sh` 生成私有配置、初始化 PostgreSQL 和首个站长超级管理员，并等待服务就绪。默认只安装博客，可选 Agent 和计划任务；登录名、昵称和初始密码可自定义，首次登录后建议更换初始密码。

```sh
bash deploy/install.sh --site-url http://localhost:8080
```

已有生产实例继续使用[部署与运维](../docs/deployment-and-ops.md)中的固定版本产物与 systemd 流程。一键安装面向空容器数据卷，不导入、不停止、不删除服务器上既有数据库，也不接管原生服务。

- `stack.py`、`docker/`：容器配置生成、镜像构建和新安装入口。
- `systemd/`：[独立服务账号](service-isolation.md)、沙箱及固定 release 模板。
- `nginx/`：原生反向代理模板与共享响应头；容器站点由 `stack.py` 生成。
- `deploy.env.example`：原生 CI/R2 发布控制配置，不能用作应用运行配置。

PostgreSQL 基线和编号迁移位于 `scripts/migration/pg/`。Agent 源码和镜像由[独立仓库](https://github.com/BigLeopardCat/saudade-blog-agent)维护，容器安装固定 `docker/agent.lock.json` 的完整提交。该锁与前端组件锁、Agent 的宿主契约锁分别管理。
