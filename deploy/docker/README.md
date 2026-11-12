# PostgreSQL 容器部署

适用于新安装和独立测试环境。博客使用 PostgreSQL 16、Rust 后端和 nginx 前端；Agent 与计划任务可选。原生生产实例继续按[运维指南](../../docs/deployment-and-ops.md)发布，不通过本安装器切库。

## 首次安装

需要 Linux、Git、Python 3.10+、Docker Engine 和 Docker Compose 2.30+。使用专门的部署账号执行；Docker 访问权限本身相当于主机管理权限。源码必须位于干净、已提交的 Git checkout，路径不能含空白或 shell 元字符。

应用镜像以完整 Git SHA 命名，Agent 版本由 `agent.lock.json` 固定。首次源码构建需要联网取得工具链、锁定依赖、组件和基础镜像。构建开销明显高于运行开销，应在构建机或 CI 构建并传送镜像，避免在承载生产的低内存服务器上构建。

```sh
git clone --branch cn_sora_blog https://github.com/BigLeopardCat/Saudade-Blog.git
cd Saudade-Blog
# 正式安装前 checkout 已审查的完整提交。
bash deploy/install.sh --site-url http://localhost:8080
```

默认绑定 `127.0.0.1:8080`，供本机反向代理使用。公开站点传入真实 `--site-url https://blog.example.com`，由宿主代理终止 TLS 并转发到该端口。该地址同时用于前端构建和公开链接，不能使用 Docker 服务名。

私有目录默认 `~/.local/share/saudade/compose`，目录 0700、凭据 0600。可用 `--state-dir /absolute/private/path` 修改。首个管理员凭据在 `administrator.json`，通过私有编辑器读取，登录后修改密码。密码不输出到命令行或日志；重跑不会重置已有管理员。用户表非空且没有管理员时，初始化拒绝修改任何账号。

## Agent 与可选功能

在私有文件中填写单行模型密钥，再生成配置：

```sh
install -d -m 700 ~/.config/saudade
install -m 600 /dev/null ~/.config/saudade/model-key
# 使用编辑器填写 model-key。
bash deploy/install.sh --site-url https://blog.example.com \
  --with-agent --with-scheduler \
  --model-key-file ~/.config/saudade/model-key --prepare-only
```

审阅生成的 `backend.env` 和 `agent.env` 后执行 `bash deploy/install.sh --reuse`。`--reuse` 保留密钥、站点、端口和功能选择，不重新解释首次安装参数。默认模型适配器为 OpenCode；其他提供商按 Agent 的[环境模板](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/.env.example)修改 `agent.env` 后启动。密钥不传入 Docker build。

不需要计划任务时省略 `--with-scheduler`，只安装博客时省略两个选项。`BLOG_API_BASE` 是公开 API，`BLOG_INTERNAL_API_BASE` 和 `AGENT_ADMIN_BASE` 走容器内 `backend:3000`；浏览器导航继续使用公开 origin。Agent 不持有博客 JWT 或工具委托签名密钥。

基线关闭混合检索和 IoT，不安装 embedding 服务，不改变 RAG 设计。邮件、对象存储、生图、审核等能力需按各自配置文档另行启用；未配置功能不视为已验收。

## TLS 与隔离

容器 nginx 也可直接终止 TLS：

```sh
bash deploy/install.sh --site-url https://blog.example.com \
  --bind 0.0.0.0 --http-port 80 --https-port 443 \
  --cert /private/fullchain.pem --key /private/privkey.pem
```

证书复制到私有目录的 `tls/site.crt`、`tls/site.key`。续期后原子替换这两个文件，保留部署账号所有及 0600，再执行 `exec frontend nginx -t` 和 `exec frontend nginx -s reload`（Compose 命令见下文）。证书不会自动续期。HTTP 跳转使用配置的 origin，包括自定义端口；健康路径不跳转。未提供证书时，8443 映射不提供 TLS 服务。

数据库、后端、Agent 无主机端口映射，只由 nginx 提供 HTTP(S)。后端和 Agent 使用固定非 root 用户；nginx 与首次初始化工具使用生成配置时的 UID/GID 读取私有文件，不要换账号复用目录。PostgreSQL 使用官方入口初始化并降权。应用根文件系统只读，持久状态使用独立卷。

## 运维与备份

以下 Bash 数组只包含路径与 profile，不读取或执行 env 文件。核心博客安装省略可选 profile；启动时仅选择已安装服务。

```sh
STATE="$HOME/.local/share/saudade/compose"
DC=(docker compose --project-directory "$STATE" --env-file "$STATE/compose.env" \
    -f "$PWD/deploy/docker/compose.yaml" --profile agent --profile scheduler)
"${DC[@]}" ps
"${DC[@]}" logs --tail 100 backend agent
curl --fail http://127.0.0.1:8080/api/health/ready
```

停止用 `stop`；移除容器用 `down`，保留命名卷。**不要添加 `down -v`**，它会删除数据库、上传内容和 Agent 状态。

备份两个数据库、上传卷及整个私有目录，备份亦需 0700/0600。数据库使用容器内部连接，密码不进入参数：

```sh
umask 077
"${DC[@]}" exec -T postgres pg_dump -U postgres -Fc saudade_blog > blog.dump
"${DC[@]}" exec -T postgres pg_dump -U postgres -Fc saudade_agent > agent.dump
"${DC[@]}" exec -T backend tar -C /var/lib/saudade -cf - uploads > uploads.tar
```

备份存放在站点目录之外，并定期在隔离环境验证恢复。备份协调期间停止写入或使用一致快照流程。

## 升级与回滚

`db-init.sh` 只对空卷运行；重启不重放基线，也不自动修改已有结构。

1. 记录两个版本，备份数据库、上传内容和私有配置。
2. 审查新旧提交间的 PostgreSQL 编号迁移，只执行新增且适用的 SQL，使用 `psql -v ON_ERROR_STOP=1`。DDL 以 `SET ROLE saudade_owner` 执行，应用角色只有 CRUD 权限。向量扩展、所有权转换、破坏性迁移单独评估，不重跑 `0000_schema.sql`。
3. 在同一源码目录切到已审查的博客完整 SHA，执行 `bash deploy/install.sh --reuse --upgrade`。它更新镜像选择、保留凭据，并将原版本选择保存到私有 `before-*` 目录；不执行数据库迁移。
4. 核对博客 `/api/health/ready`、`/build-info.json`，启用 Agent 时在容器内查询 `/ready` 和 `/version`。就绪不等于模型质量或所有业务写入已验收。

Agent 独立升级：取回干净的完整 Agent 提交，评估兼容性后修改 `compose.env` 的 `AGENT_SOURCE`、`AGENT_REVISION`，同步 `installation.json` 的 `agent_revision`，再执行 `--reuse`。不随远端 HEAD 自动升级。

回滚先确认数据库向后兼容，再切回原 SHA 并执行 `--reuse --upgrade`；Agent 同样恢复原版本选择。不兼容迁移按停写和备份恢复流程处理，不让旧程序使用新结构。

## 镜像交付与许可

提供 Dockerfile 和容器 CI，默认固定源码构建，不假定已有公共镜像。构建机先 `--prepare-only`，再用上述 Compose 命令执行 `build`。用 `docker image save` 导出指定 SHA 的 backend/frontend/agent 镜像；目标机 `docker image load` 后执行安装器 `--reuse --no-build`。目标机需有相同源码版本与配置，核对 SHA 和传输校验值；PostgreSQL 基础镜像单独准备。

镜像保留项目 GPL-2.0 与第三方声明；看板娘代码 MIT、美术 CC BY-NC-SA 4.0，Live2D Core 按独立条款分发。详见 [THIRD-PARTY.md](../../THIRD-PARTY.md)。本入口不新增公共镜像发布，资源不能误标为单一代码许可。

Compose 使用原始 env 格式保留密钥中的 `$` 和引号，因此要求 2.30+，不通过 shell `source` 配置。参考 [env_file](https://docs.docker.com/reference/compose-file/services/#env_file) 与 [up 等待就绪](https://docs.docker.com/reference/cli/docker/compose/up/)。
