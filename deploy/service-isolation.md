# 独立服务账号

Rust 使用 `saudade-blog`；Agent HTTP、scheduler 和保留清理任务使用
`saudade-agent`。两个账号都是锁定密码、nologin 的系统账号，不加入 sudo 或部署用户组。
部署账号拥有发布代码，运行账号只读代码、写各自状态。

| 路径 | 用途 |
| --- | --- |
| `/srv/saudade-agent/releases/<sha>` | 独立 venv 与固定提交；部署账号拥有、Agent 组只读 |
| `/srv/saudade-agent/current` | 部署账号切换的发布链接 |
| `/var/lib/saudade-blog/uploads` | Rust 上传目录，原有下载 URL 不变 |
| `/var/lib/saudade-blog/article-graph` | 可选文章图谱产物，由 Rust 管理 |
| `/var/lib/saudade-agent` | 本地运行数据、私有 trace、日志与评测缓存 |
| `/var/cache/saudade-agent` | uv 等运行缓存 |
| `/etc/saudade/*-runtime.env` | root 拥有，对应服务组可读，0640；不进入发布包 |

## 安装服务

```bash
sudo systemd-sysusers deploy/systemd/saudade.sysusers
sudo systemd-tmpfiles --create deploy/systemd/saudade.tmpfiles
python3 scripts/deploy/render_service_isolation.py \
  --app-dir "$APP_DIR" --release-root /srv/saudade-agent --output /tmp/saudade-units
```

输出目录必须为空。生成器输出四个完整单元、每日保留清理 timer，以及每个服务的
`90-sandbox.conf`；它不修改账号、凭据或线上服务。安装前运行 `systemd-analyze verify`，
并检查实际路径、执行账号、唯一 EnvironmentFile、可写目录及停机超时。

Rust 只读取 `/etc/saudade/blog-runtime.env`；Agent HTTP、scheduler 和维护任务只读取
`/etc/saudade/agent-runtime.env`。应用 `.env` 仅用于独立开发；生产不链接开发文件。
可选本地 embedding drop-in 只声明服务依赖，embedding 进程仍有自己的独立运行配置。
发布工具只读取部署账号的私有 R2 文件，见[发布配置](../docs/deployment-and-ops.md#发布工具配置)。

Agent 设置 `TRACE_DIR=/var/lib/saudade-agent/traces`、`BLOG_ROOT=/run/saudade-host`，
本地文件数据放在 `/var/lib/saudade-agent/data`，检索与向量索引存储在配置的 PostgreSQL；Rust 设置
`UPLOAD_DIR=/var/lib/saudade-blog/uploads`、`GRAPH_ARTIFACT_DIR=/var/lib/saudade-blog/article-graph`。
业务与 checkpoint/scheduling 数据库隔离。运行配置按 systemd EnvironmentFile 格式保存，
由 root 拥有、相应服务组读取；发布账号拥有代码，服务账号没有 sudo 权限。

## 已有安装更新

先备份 unit、所有 drop-in、环境文件权限和 current 指向到 root 私有目录，确认无并行发布。
完整单元替换旧基础单元；安装共享沙箱后，移除已合并的 `50-release.conf`、
`91-isolation.conf`、`99-entry.conf`、`zz-runtime-env.conf` 和旧停机超时覆盖。
人工核对其他站点覆盖，保留仍需的资源限制及 BGE 服务依赖；不得保留会重复加载 `.env`
或更改执行入口的旧覆盖。不能通过增加排序更靠后的文件来掩盖冲突。

不移动或覆盖已有数据。执行 daemon-reload 后，先核对 systemctl show 的实际账号、
EnvironmentFiles、ExecStart 和可写路径，再重启正式服务。验证就绪、版本、检索、持久会话、
受保护身份读取、公开图片/图谱及 scheduler 存活；启用维护 timer，首次只读检查 trace 清单。
账号沙箱应拒绝 home/SSH、其他服务密钥和 sudo，进程 `NoNewPrivs=1`、有效 capabilities 为零。

维护单元从当前固定 release 依次清理 trace、过期且不可恢复的 checkpoint、已结束的 DBOS
执行树；任一步失败会使单元失败，日志留在 journal。启用前以运行账号和相同配置执行
`python -m eval.pg_retention --json` 与 `python -m agent.scheduling.retention`，核对只读候选。
运行时必须支持带会话锁与恢复状态复查的保留清理。旧 cron 若调用开发目录下的回归或清理
脚本，先备份 crontab，再仅移除被新 timer 接管的条目；线上维护不执行模型评测和测试套件。

Rust 将已发布二进制只读 bind 到 `/srv/saudade-blog/saudade_blog_bin`，图谱挂载可选，
核心博客无需安装 Agent。宿主视图中的目标可以是零字节占位文件；实际二进制在服务的
mount namespace 内可见。核对产物时记录 `/proc/<MainPID>/exe` 的 SHA256，并使用
`nsenter --target <MainPID> --mount` 检查绑定路径，不能依据宿主占位文件判断损坏。
Agent 只挂载授权的 health/rust 日志；日志文件名和轮转策略保留。
部署失败时恢复备份的单元和 current，reload 后重启；使用同一份可写数据，不回滚新增会话或上传。

## 独立鉴权与 IoT

登录 `JWT_SECRET` 与工具委托 `BLOG_DELEGATION_SECRET` 仅交给 Rust。Rust 和 Agent 共享
另一个 `AGENT_ASSERTION_SECRET` 传递身份；确认卡使用仅 Agent 持有的 `AGENT_CONFIRM_SECRET`。
每个密钥独立生成至少 32 随机字节，按用途限制账号读取。依据
[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.12) 使用独立密钥和互斥校验规则。
新登录态带 `aud=blog-session` 和 ver；既有带 ver 的七天登录态自然过期，无 ver 令牌拒绝。

真实登录的聊天与任务面板请求签发五分钟 tools 委托，包含当前 uid、ver、scope 和 `aud=blog-tools`。
宿主每次检查当前账号冻结、代次和角色。工具委托可用 GET 读取本人会话文本与历史图片，
但不能进入登录、密码、聊天和会话控制、图谱代理或
委托交换接口。管理员后台授权最长三十天，限白名单读取、向本人投递结果和按已批准计划发布公告；后续真实聊天刷新，
过期或改密需要重新认证。切换前为已有批准计划的当前拥有者迁移有限后台授权，不重新批准计划。

IoT 使用锁定的 `saudade-device` 账号，配置模板在 `iot/deploy`。二进制只读挂载，数据库及
固件迁入 `/var/lib/saudade-device`，日志写 `/var/log/saudade-device`。SQLite 迁移需停服务并
用 backup API 包含 WAL，保留原始数据及 unit；回滚须保留迁移后新增数据。只有设备专用
`DEVICE_SIGNING_SECRET` 被映射为旧二进制固定路径读取的 JWT_SECRET，真实 home 被 tmpfs 隐藏。

浏览器和 Agent 的设备请求经过 Rust `/api/device-gateway/`：校验用户与允许路径后签发
三十秒设备令牌，保留命令的 X-Request-Id。设备自身 OTA Basic 下载与同机 MQTT 认证继续
直连设备服务；公网 broker 认证回调仍拒绝。配套 nginx 模板在 `iot/nginx/iot.conf.template`。
先验证候选网关、Agent、设备密钥，再协调切换配置、二进制及 nginx；失败一起回滚，避免新旧协议混用。
