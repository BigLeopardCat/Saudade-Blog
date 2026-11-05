# 独立服务账号

Rust 使用 `saudade-blog`；Agent HTTP、scheduler 和 trace 保留任务使用
`saudade-agent`。两个账号都是锁定密码、nologin 的系统账号，不加入 sudo 或部署用户组。
部署账号拥有发布代码，运行账号只读代码、写各自状态。

| 路径 | 用途 |
| --- | --- |
| `/srv/saudade-agent/releases/<sha>` | 独立 venv 与固定提交；部署账号拥有、Agent 组只读 |
| `/srv/saudade-agent/current` | 部署账号切换的发布链接 |
| `/var/lib/saudade-blog/uploads` | Rust 上传目录，原有下载 URL 不变 |
| `/var/lib/saudade-agent` | data、私有 trace、建图日志/缓存/报告与语音 |
| `/var/cache/saudade-agent` | uv 等运行缓存 |
| `/etc/saudade/*-runtime.env` | root 拥有，对应服务组可读，0640；不进入发布包 |

## 准备

先保存当前 unit/drop-in、环境文件、current 指向和数据权限到 root 私有备份。
记录 `/ready`、`/health`、`/version`、公开文章/图片/图谱的基线，包含检索降级状态。
确认没有并行部署，保留原发布目录直到验收完成。

```bash
sudo systemd-sysusers deploy/systemd/saudade.sysusers
sudo systemd-tmpfiles --create deploy/systemd/saudade.tmpfiles
sudo install -d -o "$DEPLOY_USER" -g saudade-agent -m 2750 /srv/saudade-agent
sudo usermod -aG saudade-agent "$DEPLOY_USER"
```

部署账号需重新登录或通过 `sudo -u "$DEPLOY_USER"` 刷新组成员资格。
创建上述状态目录，服务账号拥有；发布脚本所需子目录须允许部署账号通过服务组遍历。
不要让服务账号加入部署用户组。私有 trace 保持 0700/0600，由同一服务账号执行保留任务。

分别准备运行配置，不把原始 `.env` source 到 shell：

- Rust 保留业务数据库、JWT、图库专用 R2、图片生成等必需配置；图库凭据配全后使用
  `R2_IMAGE_ENDPOINT`，移除部署桶的 access/secret key。
- Agent 合并自身和 embedding 配置，移除未使用的业务 `DATABASE_URL`；保留专用的
  checkpoint/scheduling 连接。配置 `TRACE_DIR=/var/lib/saudade-agent/traces`、
  `BLOG_ROOT=/run/saudade-host`，将向量目录调整到 `/var/lib/saudade-agent/data` 下。
- Rust 配置 `UPLOAD_DIR=/var/lib/saudade-blog/uploads` 和
  `GRAPH_ARTIFACT_DIR=/var/lib/saudade-blog/article-graph`。
- 按 systemd EnvironmentFile 格式保存，并验证各账号只能读取自己所需的密钥。

使用 Agent 仓配套脚本准备发布，不切换线上服务：

```bash
DEPLOY_SERVICE_GROUP=saudade-agent \
DEPLOY_RUNTIME_STATE=/var/lib/saudade-agent \
DEPLOY_PREPARE_ONLY=1 \
bash scripts/deploy_release.sh "$REVISION" /srv/saudade-agent \
  /etc/saudade/agent-runtime.env /var/lib/saudade-agent/data
```

后续发布仍使用上述服务组、状态目录和新 release/config/data 参数。配置了固定 tokenizer
的站点还需传 `DEPLOY_EMBEDDING_TOKENIZER=1` 并检查检索健康，不能仅以 HTTP 就绪代替。
复制模式避免发布权限整理修改 uv 缓存硬链接。外置的是建图运行报告，归档中的评测基线保留。

## 验证与切换

先用相同沙箱在另一回环端口启动临时 Agent，不启动第二个 scheduler。可临时 bind 原状态
目录供验证；检查代码只读、状态可写、home/SSH 和其他服务密钥不可读、sudo 不可用。

```bash
python3 scripts/deploy/render_service_isolation.py \
  --app-dir "$APP_DIR" --release-root /srv/saudade-agent --output /tmp/saudade-units
```

生成器只输出配置，不修改系统。维护窗口内排空并停止 Rust、Agent、scheduler 和临时实例，
迁移 uploads、Agent data、trace 到新状态目录；同文件系统可 rename，跨文件系统先复制并
最终同步。旧路径可以保留兼容链接，不删除原数据或用旧副本覆盖新内容。公开 graph/web 目录
和文件为 0755/0644，其他私有文件不因此开放。

切换 current，将生成文件以 root:root、0644 安装到 `/etc/systemd/system/`；保留原 unit
及其他 drop-in。执行 `systemd-analyze verify`、daemon-reload，再启动三个正式服务。
验收实际 PID 的 UID/GID、`NoNewPrivs: 1`、`CapEff: 0`，核对就绪/版本/检索/持久会话、
公开 API、已有图片与图谱、受保护身份读取、上传读写，以及 scheduler 存活。

启用 `saudade-agent-maintenance.timer`，让既有 trace 保留逻辑以所属账号运行，不调用模型。
首次先用相同沙箱只读统计，确认可读取私有 trace。

Rust 将原部署二进制只读 bind 到 `/srv/saudade-blog/saudade_blog_bin`，原发布脚本继续负责
替换二进制及重启。tmpfiles 创建可执行目标占位文件，实际执行的是服务沙箱内挂载的发布二进制。
Agent 诊断只挂载已授权的 health/rust 日志，不暴露整个工作区；日志轮转
须保留这两份文件的服务组读权限。

## 回滚

失败时停止新实例，恢复备份的 unit/drop-in 和原 current，daemon-reload 后启动原服务。
保留迁移后的同一份数据和旧路径兼容链接，恢复原账号所需的目录权限。不要用迁移前的数据
覆盖新上传或会话。恢复稳定后再清理临时 unit；不在回滚中删除账号、备份或数据。

操作系统隔离不代替业务授权。Agent 仍持有共享 JWT 签名密钥；登录与工具委托的用途、scope
和撤销规则需要两仓另行迁移，本次不直接拒绝无 ver 令牌而破坏工具调用。
