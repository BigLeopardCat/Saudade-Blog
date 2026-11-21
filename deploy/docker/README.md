# PostgreSQL 容器部署

适用于新安装和独立测试环境。博客使用 PostgreSQL 16、Rust 后端和 nginx 前端；Agent 与计划任务可选。原生 systemd 实例按[运维指南](../../docs/deployment-and-ops.md)发布。

## 首次安装

需要 Linux、Git、Python 3.10+、Docker Engine 和 Docker Compose 2.30+。使用专门的部署账号执行；Docker 访问权限本身相当于主机管理权限。源码必须位于干净、已提交的 Git checkout，路径不能含空白或 shell 元字符。

应用镜像以完整 Git SHA 命名，Agent 版本由 `agent.lock.json` 固定。首次源码构建需要联网取得工具链、锁定依赖、组件和基础镜像。构建开销明显高于运行开销，应在构建机或 CI 构建并传送镜像，避免在承载生产的低内存服务器上构建。

```sh
git clone --branch main https://github.com/BigLeopardCat/Saudade-Blog.git
cd Saudade-Blog
# 正式安装前 checkout 已审查的完整提交。
bash deploy/install.sh --site-url http://localhost:8080
```

默认绑定 `127.0.0.1:8080`，供本机反向代理使用。公开站点传入真实 `--site-url https://blog.example.com`，由宿主代理终止 TLS 并转发到该端口。该地址用于服务器生成的公开链接和 sitemap，不能使用 Docker 服务名。

Docker 前端默认以可移植模式构建，页面链接和元数据使用浏览器当前 origin，不固定构建机域名。
容器的 `robots.txt` 按配置的 `SITE_URL` 提供 sitemap 地址，`sitemap.xml` 由后端生成。
常规 Vite 构建仍通过 `VITE_SITE_URL` 固定站点身份；自定义站名、描述或署名时按前端配置重新构建。

私有目录默认 `~/.local/share/saudade/compose`，目录 0700、凭据 0600。可用 `--state-dir /absolute/private/path` 修改。密码不输出到命令行或日志。

### 首次站长账号

安装器自动生成 `administrator.json`；真正的账号在首次启动时由 `bootstrap` 服务创建，且只允许空用户表。
首个账号是博客的**超级管理员 `superadmin`**，默认登录名 `admin`、昵称“站长”，初始密码随机生成。
这不授予 PostgreSQL 超级用户权限，数据库应用账号仍只有业务 CRUD 权限。

账号并非固定：可在首次准备时自定义登录名、昵称和密码。密码通过仅本人可读的文件提供，不作为命令行参数：

```sh
install -d -m 700 ~/.config/saudade
install -m 600 /dev/null ~/.config/saudade/initial-password
# 使用编辑器填写单行初始密码；不要把密码写入命令或 shell 历史。
bash deploy/install.sh --site-url http://localhost:8080 \
  --admin-user site-owner --admin-nickname '站长' \
  --admin-password-file ~/.config/saudade/initial-password --prepare-only
# 用私有编辑器审阅 ~/.local/share/saudade/compose/administrator.json。
bash deploy/install.sh --reuse
```

省略 `--admin-password-file` 即生成随机密码。登录名为 3–64 个 ASCII 字母、数字或 `_.-`，
昵称最多 64 字，密码为 12–1024 个 UTF-8 字节。不要在 JSON 中增加 `role` 字段，首次角色由服务端确定。
也可只执行 `--prepare-only`，在首次启动前手动编辑 `administrator.json` 的 `username`、`nickname`、`password`，
保持文件 0600，再使用同一私有目录执行 `--reuse`。准备配置阶段不会连接数据库或创建账号，不需要交互式终端。
启用 Agent 时，应将账号参数与下一节的功能选项放在同一次首次准备命令中。

**首次登录后建议在个人中心更换初始密码。** 初始凭据文件不会跟随登录后的密码变更自动更新。
`--reuse`、重建镜像及修改初始 JSON 都不会重置已有密码或改变角色；已有 `admin` 或 `superadmin` 时跳过创建，
不会把普通管理员自动提权。用户表非空但没有管理员时初始化失败，交由维护者核实，不接管已有账号。

## Agent 与可选功能

本节和上一节是两种首次安装方案，在生成配置前择一执行；`--reuse` 不切换已有安装的 profile。

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

已有核心博客安装如需追加 Agent，保留现有私有目录及全部签名密钥：填写 `agent.env` 中的模型配置，按 `agent.lock.json` 取回干净的 Agent 源码，在 `compose.env` 设置其 `AGENT_SOURCE` 和 `AGENT_REVISION`，并在 `installation.json` 同步 `agent_revision`、`with_agent=true`。需要 worker 时同时设置 `with_scheduler=true` 和 `agent.env` 的 `SCHEDULING_ENABLED=true`，然后执行 `--reuse`。首次初始化已经建立独立 Agent 数据库，无需重建博客库。

## TLS 与隔离

容器 nginx 也可直接终止 TLS：

```sh
bash deploy/install.sh --site-url https://blog.example.com \
  --bind 0.0.0.0 --http-port 80 --https-port 443 \
  --cert /private/fullchain.pem --key /private/privkey.pem
```

证书复制到私有目录的 `tls/site.crt`、`tls/site.key`，文件保持 0600，TLS 子目录保持 0700。
这些副本归前端运行 UID/GID 所有；其他运行凭据仍归部署账号所有。非 root 安装使用部署账号的非零 UID，
root 安装使用 nginx 的 `101:101`，不通过开放其他用户读取权限让 nginx 访问私钥。

续期时用原部署账号原子替换这两个文件并保持 0600，执行
`bash deploy/install.sh --state-dir /absolute/private/path --reuse --prepare-only` 校正副本归属，
再执行 `exec frontend nginx -t` 和 `exec frontend nginx -s reload`（Compose 命令见下文）。
证书不会自动续期。HTTP 跳转使用配置的 origin，包括自定义端口；健康路径不跳转。未提供证书时，8443 映射不提供 TLS 服务。

数据库、后端、Agent 无主机端口映射，只由 nginx 提供 HTTP(S)。后端、Agent 和 nginx 均以非 root 用户运行。
nginx 的 `/tmp` 是归运行 UID 所有的 0700 tmpfs，限制 64 MiB；PID 和请求临时文件只写该挂载，根文件系统保持只读，
不添加 Linux capabilities。首次账号初始化工具使用部署账号 UID/GID 读取私有凭据，不要换账号复用安装目录。
PostgreSQL 使用官方入口初始化并降权，持久状态使用独立卷。

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

备份数据库、上传卷及整个私有目录，存放在站点目录之外并使用 0700/0600 权限。
先停止应用写入，保留 PostgreSQL 运行；仅博客安装的停止命令只填写 `frontend backend`，
省略 Agent 数据库备份。上传卷通过一次性容器读取，密码不进入参数：

```sh
umask 077
"${DC[@]}" stop frontend backend agent scheduler
"${DC[@]}" exec -T postgres pg_dump -U postgres -Fc saudade_blog > blog.dump
"${DC[@]}" exec -T postgres pg_dump -U postgres -Fc saudade_agent > agent.dump
"${DC[@]}" run --rm --no-deps -T --entrypoint tar backend \
  -C /var/lib/saudade -cf - uploads > uploads.tar
sha256sum blog.dump agent.dump uploads.tar > backup.sha256
"${DC[@]}" up --no-build --wait
```

恢复先在隔离主机使用同一版本的干净源码和私有配置，核对 `backup.sha256`。
让新空 PostgreSQL 完成角色初始化后，停止应用写入，使用 `pg_restore --exit-on-error`
恢复到独立空库，不向正在使用的生产库重放。角色、所有权和授权也必须保留。
上传内容使用相同 UID/GID 恢复到隔离卷，私有配置按原权限恢复。验收管理员登录、文章、
原图、Agent checkpoint 与版本组合后，再按维护窗口切换；恢复成功不代表允许重放未知写入。

容器 CI 对完整安装执行实际 `pg_dump/pg_restore`、LangGraph checkpoint 重读、上传文件恢复，
并拒绝无效配置后回到原镜像与凭据；独立新卷验证仅博客安装、root 安装下的非 root nginx、
私钥读取、TLS 重载与重建，以及首个超级管理员登录和已有账号保护。
演练不执行破坏性 schema 降级，使用合成数据，不证明生产备份仍有效；维护者仍应
在隔离环境恢复自己的最新备份。数据库回滚与应用镜像回滚分别评估。

## 升级与回滚

`db-init.sh` 只对空卷运行；重启不重放基线，也不自动修改已有结构。

1. 记录两个版本，备份数据库、上传内容和私有配置。
2. 审查新旧提交间的 PostgreSQL 编号迁移，只执行新增且适用的 SQL，使用 `psql -v ON_ERROR_STOP=1`。DDL 以 `SET ROLE saudade_owner` 执行，应用角色只有 CRUD 权限。向量扩展、所有权转换、破坏性迁移单独评估，不重跑 `0000_schema.sql`。
3. 在同一源码目录切到已审查的博客完整 SHA，执行 `bash deploy/install.sh --reuse --upgrade`。它更新镜像选择、保留凭据，并将原版本选择保存到私有 `before-*` 目录；不执行数据库迁移。
4. 核对博客 `/api/health/ready`、`/build-info.json`，启用 Agent 时在容器内查询 `/ready` 和 `/version`。就绪不等于模型质量或所有业务写入已验收。scheduler 探针等待 DBOS 初始化和队列注册后检查进程标记；不调用模型或业务接口，也不证明数据库持续可用或任务处理时延。

Agent 独立升级：取回干净的完整 Agent 提交，评估兼容性后修改 `compose.env` 的 `AGENT_SOURCE`、`AGENT_REVISION`，同步 `installation.json` 的 `agent_revision`，再执行 `--reuse`。不随远端 HEAD 自动升级。

回滚先确认数据库向后兼容，再切回原 SHA 并执行 `--reuse --upgrade`；Agent 同样恢复原版本选择。不兼容迁移按停写和备份恢复流程处理，不让旧程序使用新结构。

## 镜像交付与许可

发行版可提供经验证的预构建镜像与原生产物，见[快速安装](../prebuilt.md)。从同一 Release 获取镜像归档及 SHA256SUMS，校验后 `docker load --input` 导入，再用完整 SHA 对应的干净源码执行 `deploy/install.sh --reuse --no-build`。首次准备配置、备份与升级要求不变。

维护者手动运行 `PostgreSQL container` 并选择 `package_images`，只有端到端安装和恢复检查全部成功才导出安装包。指定 `release_tag` 时只允许附加到同版本、同完整源码的草稿 Release；构建工作流不自动正式发布。Actions artifact 保留七天，正式版本由维护者审核后长期附在 GitHub Release。归档不包含运行配置和数据卷。

也可在构建机先 `--prepare-only`，再用上述 Compose 命令执行 `build` 和 `docker image save` 导出指定版本。目标机验证校验值、`docker image load` 后执行安装器 `--reuse --no-build`；需有相同版本的干净源码和独立生成的配置，不复用构建机的管理员密码及模型密钥。

镜像保留项目 GPL-2.0 与第三方声明；看板娘代码 MIT、美术 CC BY-NC-SA 4.0，Live2D Core 按独立条款分发。详见 [THIRD-PARTY.md](../../THIRD-PARTY.md)。本入口不新增公共镜像发布，资源不能误标为单一代码许可。

Compose 使用原始 env 格式保留密钥中的 `$` 和引号，因此要求 2.30+，不通过 shell `source` 配置。参考 [env_file](https://docs.docker.com/reference/compose-file/services/#env_file) 与 [up 等待就绪](https://docs.docker.com/reference/cli/docker/compose/up/)。
