# 部署与运维

## 配置

开发环境由 dotenv 读取本地 `.env`，进程环境优先；生产由 systemd 注入 `/etc/saudade/blog-runtime.env`，工作目录为独立状态目录，不读取开发 checkout。必需 `DATABASE_URL`、随机 `JWT_SECRET`；公开部署设置 `SITE_URL`，前端构建设置对应 `VITE_SITE_URL`。完整配置样例见[环境模板](../.env.example)。配置文件不入库，前端不得持有模型或对象存储密钥。

启用 Agent 时另配 `BLOG_DELEGATION_SECRET`、`AGENT_ASSERTION_SECRET`；设备网关另配
`DEVICE_SIGNING_SECRET`。密钥用途见[安全边界](security-boundary.md)，不复制整份博客 .env 给 Agent。
独立运行账号使用 `/etc/saudade/*-runtime.env`，由 systemd 注入；路径和账号要求见
[独立服务账号](../deploy/service-isolation.md)。

Rust 默认监听 loopback 3000，前端静态文件由 nginx 提供。Agent、模型服务和设备演示仅在启用时安装；不要将内部管理端口直接暴露公网。

### 发布工具配置

CI 通过环境注入四个 R2 发布字段；服务器部署账号使用独立的
`~/.config/saudade/deploy.env`（目录 0700、文件 0600、归部署账号所有），样例见
[`deploy/deploy.env.example`](../deploy/deploy.env.example)。自定义绝对路径可设置
`SAUDADE_DEPLOY_ENV_FILE`。字段仅含 `R2_ENDPOINT`、`R2_ACCESS_KEY`、`R2_SECRET_KEY`、
`R2_BUCKET`，不得混入博客业务、图库或 Agent 的密钥。显式指定的文件不存在即失败。

发布工具使用 python-dotenv 解析引号，禁止 shell 执行和变量插值；进程环境优先。
CI 配齐四项时不读取机器文件。配置不会写入发布包或修改 `DEPLOY_SHA`。

```sh
python3 -m venv ~/.local/share/saudade/deploy-venv
~/.local/share/saudade/deploy-venv/bin/python -m pip install -r scripts/deploy/requirements.txt
SAUDADE_DEPLOY_PYTHON=~/.local/share/saudade/deploy-venv/bin/python \
  bash scripts/deploy/trigger_deploy.sh FULL_COMMIT_SHA
```

服务器默认使用上述独立 venv，可由 `SAUDADE_DEPLOY_PYTHON` 指定其他已安装依赖的解释器；
CI 安装同一份固定版本依赖。部署控制脚本不在业务产物中；更新脚本或工具依赖时，
应在没有发布任务运行时单独安装已审查版本，再触发发布，不覆盖其他工作树的未提交改动。

## PostgreSQL

使用独立开发/CI 实例测试迁移。基线 `scripts/migration/pg/0000_schema.sql` 用于空数据库，不在既有生产库重跑。其数据库名称和时区要求见[开发指南](../CONTRIBUTING.md)。增量结构通过新编号 PostgreSQL 迁移演进，不回到 MySQL 重新生成基线。

```sh
python3 scripts/migration/pg/ci_schema_files.py
python3 scripts/migration/pg/ci_schema_files.py --self-test
```

该脚本打印公共 CI 使用的有序结构迁移；被排除的向量扩展、角色所有权与破坏性切换须按实际部署单独评估。执行 SQL 使用 `psql -v ON_ERROR_STOP=1`，先备份并核对当前版本。

Agent 的 `CHECKPOINT_DSN` 指向独立数据库；不要把框架 schema 建到博客业务库。核心博客不依赖 checkpoint 数据库。

## 服务与发布

服务模板位于 `deploy/systemd/`，nginx 和安装入口位于 `deploy/`。先审阅模板中的账号、路径、站点及可选能力，再安装。辅助脚本不能替代运行环境核对，特别是已有数据库和远程对象存储。

主线 `cn_sora_blog` 的发布工作流先运行 Rust、PostgreSQL、前端及浏览器检查，再构建固定提交产物、上传 R2 并通知服务器部署。PR 不部署，也不读取生产 secret。主线文档提交同样触发完整快照发布。发布后分别核对 `/build-info.json`、Rust 二进制产物来源及校验值、Agent `/version`，再查探针、静态资源和服务日志；本地 HEAD、组件 pin 和 CI 绿灯不能代替实际运行版本。

Agent 服务独立发布，操作见 [Agent 部署](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/deployment.md)。只有采用组件子树更新时才修改 `frontend/widget.lock.json` 的提交和子树哈希；构建前执行 `fetch:widget`、`vendor:live2d`。

## 停机与任务

Rust 接收 SIGTERM 后停止接受 HTTP 请求，拒绝新的付费生图，排空已有 HTTP handler，并通过 Tokio TaskTracker 等待已接受的生图和聊天写入任务持久化。服务模板预留 `TimeoutStopSec=360`，大于图片提供商请求超时及结果保存时间。已有安装升级时也要更新该服务配置。

强制终止、断电或远端成功但本地未记账仍可能形成未知结果。未知付费请求不能自动重试；先核实提供商和本地记录。聊天暂停和后台持久计划由 Agent 的 LangGraph 与 DBOS 分别管理，不能用 Web 连接存活判断任务存活。

## 日志、容量与回滚

- Rust 使用结构化 tracing；反向代理、服务单元和部署脚本记录各自错误与构建版本。
- Agent trace、模型 usage 和任务指标由 Agent 管理；日志目录与保留策略显式配置，不推测开发 checkout 路径。
- `scripts/healthcheck.sh` 检查服务状态；`scripts/check_security_headers.sh` 检查公开响应头。探针失败需结合实际日志处理。
- 关注磁盘剩余、日志增长、对象存储、数据库连接与真实活动任务数；闲置网页不是工作线程。
- 代码回滚不等于数据回滚。保留上一版本产物、数据库备份及恢复步骤；涉及不兼容 schema 时先评估回退条件。

AI 生图通过 `OPENAI_IMAGE_API_KEY`、`OPENAI_IMAGE_BASE_URL`、`OPENAI_IMAGE_MODELS` 配置，仅后端读取。列表需与账号权限匹配；密钥未配置时不允许付费调用。不要用真实付费生成验证普通 CI。

生图需要专用出站代理时，设置 `OPENAI_IMAGE_PROXY_URL=http://127.0.0.1:17891`，支持 HTTP/HTTPS 代理。只作用于生图服务请求，图库参考图下载使用独立直连客户端；不设置全局 `HTTP_PROXY`、`HTTPS_PROXY` 或 TUN。代理不可用时请求失败，不自动改走直连或重复付费请求。HTTPS 通过 CONNECT 保持服务端证书校验，代理配置及订阅凭据保存在仓库外私有文件中。留空即恢复直连。
