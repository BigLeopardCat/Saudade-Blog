# 部署与运维手册

> 单机部署拓扑（腾讯云轻量服务器，3.7GB 内存）：nginx 直接服务前端 dist，API 反向代理到
> Rust 后端，Python Agent 作为对话服务的下游。本机既是开发机也是生产服务器，**部署一律走 CI**，
> 本机不编译（见 §2.3 约定）。

---

## 1. 架构拓扑与端口

```
访客浏览器
   │ 443 (HTTPS, nginx)
   ▼
nginx (/etc/nginx/sites-enabled/blog)
   ├── /                        → 前端静态文件（frontend/dist，SPA）
   ├── /api/*                   → 127.0.0.1:3000  Rust 后端
   ├── /api/chat/stream         → Rust → 127.0.0.1:8010  Python Agent（SSE 转发）
   ├── /device-console/         → IoT 控制台静态页（mqtt-demo/device-console/）
   ├── /device-api/*            → 127.0.0.1:3100  device-service（IoT API）
   └── mqtts://saudade.site:8883 → EMQX MQTT broker（设备接入）
```

| 端口 | 进程 | 服务 | 说明 |
|---|---|---|---|
| 80/443 | nginx | `nginx` | 静态 + 反代 + SSE 透传（`X-Accel-Buffering: no`） |
| 3000 | Rust 后端 | `saudade-rust` | axum + sea-orm + MySQL；博客主 API + 对话编排 |
| 8010 | Python Agent | `saudade-agent` | FastAPI，2 workers；对话生成 + 工具执行 + RAG |
| 3100 | IoT 设备服务 | `saudade-device` | Rust；设备注册/遥测/cmd 下发（校验博客 JWT） |
| 8883 | EMQX | `emqx` | MQTT over TLS；设备 ↔ device-service 消息总线 |
| 3306 | MySQL | `mysql` | 博客业务库 + 对话历史 + IoT 数据 |

依赖：MySQL 8（`memory_blog` 库）、EMQX（`emqx.service`，MQTTS 证书在 `/etc/letsencrypt/live/saudade.site/`）。

---

## 2. CI/CD 部署链路

### 2.1 流水线（GitHub Actions，`.github/workflows/deploy.yml`）

push 到 `cn_sora_blog` 分支触发 `build-and-deploy`：

```
源码 → [cloud] cargo build --release（Rust 二进制）
     → [cloud] vite build（React 前端 → dist）
     → [cloud] 打包 deploy.tar.gz（二进制 + dist）→ 上传 R2（cloudflare R2，中转桶）
     → [cloud] SSH 触发本机 scripts/deploy/deploy_from_r2.sh
     → [本机] 下载解压 → 替换二进制 → systemctl restart saudade-rust
     → [本机] dist 已解压到正确位置 → nginx 直接服务新文件（无需重启）
```

- **R2 只作部署中转，不当静态直服**（20260830 测速定论：R2 跨境 TTFB 0.7-1.3s vs 服务器骨干网毫秒级，3M 出站带宽下本地直服仍是正解；详见 agent 仓库 docs/问题记录.md 与 roadmap 记忆）。
- 密钥全走 GitHub Secrets（`R2_ENDPOINT/ACCESS/SECRET/BUCKET`）与服务器 `.env`，无硬编码。
- **前端强缓存**：`location ~* ^/(live2d_model|cubism5|live2d-widgets)/` 设 1 年 immutable（须置于 `\.(js|css|json)$` no-store 正则**之前**）；`autoload.js`/`waifu.css` 换版靠 `?v=` bump（4 处同步，见 §4）。

### 2.2 逃生通道（仅 CI 故障时）

```bash
export $(grep -v '^\s*#' .env | grep -v '^\s*$' | xargs)
python3 scripts/deploy/upload_to_r2.py && bash scripts/deploy/deploy_from_r2.sh
```

风险自担：本机执行构建（见下）。

### 2.3 硬性约定（20260830 事故后）

- **本机不编译、不手动构建**：机器仅 3.7GB 内存，vite build（3072 堆）+ 常驻服务并发会 OOM
  拖垮整机（2026-08-30 实际发生，服务器重启 5 分钟）。部署一律走 CI 云端构建。
- **本地验证用轻量命令**：前端不构建直接 push 等 CI；后端 `cargo check`（不 `build --release`）。
- **CI 严格模式**：`RUSTFLAGS="-D warnings" cargo check`——任何 warning 会导致 CI 构建失败，提交前必跑。

---

## 3. 服务管理（systemd）

三个 systemd 服务（均 `Restart=always` / `on-failure` 崩溃自愈 + `enable` 开机自启）：

| 服务 | ExecStart | 日志 | 说明 |
|---|---|---|---|
| `saudade-rust` | `target/release/saudade_blog_bin`（WorkingDirectory=/home/ubuntu/memory_blog_rust） | `logs/rust.log` | dotenv 自动加载 WorkingDirectory 下 `.env` |
| `saudade-agent` | `.venv/bin/python server.py`（2 workers） | `logs/agent/agent.log` | `TimeoutStopSec=120` 优雅停等在途对话 |
| `saudade-device` | `mqtt-demo/device-service/target/release/device-service` | `logs/device.log` | EnvironmentFile=`svc.env`（含 DEVICE_LOG_FILE） |

**勿再 nohup 裸跑** Rust/agent（历史遗留习惯）——会与 systemd 抢 3000/8010 端口。

常用命令：

```bash
sudo systemctl status saudade-rust            # 状态（Restart 计数=崩溃次数）
sudo systemctl restart saudade-agent          # agent 改动生效（无状态，重启安全）
journalctl -u saudade-agent -n 50             # 服务日志（追加进 logs/agent/agent.log）
sudo systemctl status emqx mysql nginx        # 基础设施健康
```

版本升级时二进制替换由 `deploy_from_r2.sh` 完成（`cp → chmod +x → restart`），前端 dist 解压即生效。

---

## 4. 日志体系（20260830f 分组规范）

`logs/` 根目录为集中日志区，按组分层：

```
logs/
├── rust.log            # Rust 后端：全局 access 行（http method= path= status= ms=）+ 业务日志
├── agent/              # Agent 组
│   ├── agent.log       # Python agent 生命周期（tid= trace_id 前缀）
│   └── traces/         # 对话 trace JSON（<ts>_<user_id>_<trace_id8>.json，节点事件+分段耗时+退出原因）
├── frontend/           # 前端组
│   └── monitor.log     # 前端错误上报（POST /api/monitor/log 匿名可写，8KB body 上限）
├── device.log          # IoT device-service
├── deploy.log          # CI 触发记录
├── health.log          # 心跳探针告警
└── archive/            # 历史归档
```

- **轮转**：`/etc/logrotate.d/saudade`——daily + rotate 14 + compress + copytruncate（追加写免重启），
  glob 覆盖 `logs/*.log` + `logs/agent/*.log` + `logs/frontend/*.log` + traces 两处。
  **注意 `su ubuntu ubuntu`：日志文件属主必须是 ubuntu**，systemd 迁移后 root 属主会静默轮转失败
  （20260830 已 chown 修正，新文件由 ubuntu 进程写天然属主正确）。
- **时区**：Rust 与 agent 日志统一本地 +08:00 钟面（`ChronoLocal::new("%Y-%m-%d %H:%M:%S%.3f")`），
  跨文件对账无 8 小时差。
- **心跳探针**：`scripts/healthcheck.sh`（cron 每分钟）——① 3000 存活（GET /api/login 405=存活）
  ② 8010 `/health` agent_ready ③ **uvicorn worker 崩溃检测**（pid 集合对比，worker 静默死亡无任何
  日志，2026-08-29 事故根因）④ **nginx error.log 增量扫描**（字节数基线 + tail -c 增量 grep
  error/crit/alert/emerg）。异常追加 `logs/health.log`。
- **排障首选 trace**：对话异常直接读 `logs/agent/traces/` 对应文件的分段耗时
  （planner/model/tools/reflector），不必翻日志；`agent.log` grep `慢调用` 即 LLM 慢请求事故清单。

---

## 5. 配置速查

- **Rust `.env`**（/home/ubuntu/memory_blog_rust/.env）：`DATABASE_URL`（mysql://memory_blog:*@127.0.0.1:3306/memory_blog，`timezone(Some("+08:00"))`）、`JWT_SECRET`、`AGENT_URL`、`QWEN_API_KEY` 等。`dotenv()` 由 main.rs 在 WorkingDirectory 加载。
- **agent `.env`**（saudade-blog-agent/.env，gitignore）：`LLM_PROVIDER=qwen`、`QWEN_MODEL=qwen3.8-flash`、`LLM_ENABLE_THINKING`、`TRACE_DIR=logs/agent/traces`、IoT JWT 代签密钥等。模板见 `.env.example`。
- **device-service `svc.env`**：MQTT broker、`DEVICE_LOG_FILE`、JWT 校验公钥侧配置。
- **nginx**：`/etc/nginx/sites-enabled/blog`（443 块两个 server：saudade.site + 泛域）；勿在 sites-enabled 放备份文件（nginx 会加载导致 duplicate server，备份移 /home/ubuntu/）。

---

## 6. 故障排查手册

| 症状 | 排查路径 |
|---|---|
| 对话无响应/卡死 | ① `curl http://127.0.0.1:8010/health`（agent_ready？）→ ② `journalctl -u saudade-agent` / agent.log 生命周期行（end reason：超时/断连/错误）→ ③ trace 分段耗时（模型慢？工具挂？）→ ④ `grep 慢调用 agent.log` |
| 页面白屏/看板娘不出现 | ① nginx error.log（探针已盯）→ ② 前端 monitor.log（js_error/fetch_fail 上报）→ ③ 版本号缓存（`?v=` 未同步？浏览器强缓存） |
| Rust 崩溃自愈但反复重启 | `systemctl status saudade-rust`（Restart 计数）+ rust.log 尾部（panic/DB 连接失败） |
| 设备离线/指令无效 | ① device-service 日志（mqtt.rs 三段：入队→发出→broker 确认）→ ② EMQX 状态 → ③ 设备端 cmd_history 回执（req_id 对账） |
| worker 静默死亡 | health.log（探针 pid 对比告警）+ uvicorn master 进程树（worker 是 `python3 -c spawn_main` 子进程） |
| 日志不轮转 | `ls -l logs/*.log` 属主（必须 ubuntu）+ `sudo logrotate -d /etc/logrotate.d/saudade` 干跑验证 |

**四端日志对账**：`trace_id`（X-Request-Id）贯穿 前端 → Rust → Python → device-service → ESP32 回执，
一个 id 串起全部端日志——排障先按 trace_id 找全链路。

---

## 7. 安全要点

- 登录密码 SHA256（`utils.rs encrypt_password`）；JWT HS256（`JWT_SECRET` 签名，sub=i32）。
- 前端错误上报端点 `/api/monitor/log` 匿名可写（访客错误上报最有价值），防刷靠 8KB body 上限 +
  logrotate 兜底磁盘。
- IoT API 全部校验博客 JWT（device-console 复用 `localStorage.tokenKey`，无二次登录）。
- R2 密钥与 API key 均从 Secrets/.env 注入，无硬编码；20260829 已滚动密钥。
