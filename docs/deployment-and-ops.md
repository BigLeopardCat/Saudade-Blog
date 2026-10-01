# 部署与运维手册

> 单机部署（一台 3.7GB 内存的轻量云服务器）：nginx 直接服务前端构建产物，API 反向代理到
> Rust 后端，Python Agent 作为对话服务的下游。**本机既是开发机也是生产服务器**——所以
> 「部署一律走 CI、本机不编译」是硬约定（§2.3，这条是拿一次 OOM 事故换来的）。
>
> 本文保留**设计判断与排障思路**；具体服务名、路径与可复制的运维命令属私有运行簿，不进仓库。

---

## 1. 架构拓扑与端口

```
访客浏览器
   │ 443 (HTTPS)
   ▼
nginx（唯一公网入口）
   ├── /                → 前端构建产物（SPA，静态直服）
   ├── /api/*           → Rust 后端（回环 :3000）
   ├── /api/chat/stream → Rust → Python Agent（回环 :8010，SSE 转发）
   ├── /device-console/ → IoT 控制台静态页
   ├── /device-api/*    → device-service（回环 :3100）
   └── mqtts://…:8883   → EMQX MQTT broker（设备接入）
```

| 端口 | 进程 | 说明 |
|---|---|---|
| 80/443 | nginx | 静态 + 反代 + SSE 透传（`X-Accel-Buffering: no`，否则帧被缓冲成一次性返回） |
| 3000 | Rust 后端 | axum + sea-orm + MySQL；博客主 API + 对话编排 |
| 8010 | Python Agent | FastAPI，2 workers；对话生成 + 工具执行 + RAG |
| 3100 | IoT 设备服务 | Rust；设备注册/遥测/cmd 下发（校验博客 JWT） |
| 8883 | EMQX | MQTT over TLS；设备 ↔ device-service 消息总线 |
| 3306 | MySQL | 博客业务库 + 对话历史 + IoT 数据 |

**除 nginx 外全部只绑回环**——这是整套信任模型的基石，边界细节与实测命令见
[security-boundary.md](security-boundary.md)。依赖：MySQL 8、EMQX（MQTTS 证书与 nginx 侧同源
双副本，续期要两处同步）。

---

## 2. CI/CD 部署链路

### 2.1 流水线（GitHub Actions）

push 到 `cn_sora_blog` 分支触发构建与部署：

```
源码 → [云端] cargo build --release（Rust 二进制）
     → [云端] vite build（React → dist）
     → [云端] 打包（二进制 + dist）→ 上传对象存储中转桶（R2）
     → [云端] SSH 触发本机部署脚本
     → [本机] 下载解压 → 替换二进制 → 重启 Rust 服务
     → [本机] dist 解压到位 → nginx 直接服务新文件（无需重启）
```

三条判断，都是量过才定的：

- **为什么在云端构建**：机器只有 3.7GB 内存，vite build 的堆需求（约 3GB）与常驻服务并发会
  OOM 拖垮整机（2026-08-30 实际发生，服务器重启 5 分钟）。所以本机只做 `cargo check` 级别的
  轻量验证，真正的构建交给 CI runner。
- **为什么中转桶不当静态直服**：测速定论——R2 跨境 TTFB 0.7–1.3s，而服务器骨干网出站是毫秒级；
  3M 出站带宽下本地直服仍是正解。对象存储在这里承担的是「云端产物 → 本机」的搬运，不是 CDN。
- **密钥全走 CI Secrets 与服务器环境文件**，无硬编码。

**前端强缓存**：对少量重资源目录（Live2D 模型与运行时）设 1 年 `immutable`；该 location 必须排在
`\.(js|css|json)$` 的 no-store 正则**之前**（否则被后者的规则吃掉）。这类目录换版靠 `?v=` bump，
同步点不止一处；完整清单见 [frontend/README.md](../frontend/README.md) 的《改这里的文件要 bump 版本号》
一节（那是唯一事实源，本文不另列一份以免漂移）。

### 2.2 逃生通道（仅 CI 故障时）

本机保留一条「本地打包 → 上传中转桶 → 本机部署」的手动路径，供 CI 不可用时救急。**它会在本机
触发构建，是已知风险，只在 CI 挂掉时用**；具体命令见私有运行簿。

### 2.3 硬性约定

- **本机不编译、不手动构建**（原因见 §2.1 那次 OOM）。
- **本地验证用轻量命令**：前端不构建、直接 push 等 CI；后端只 `cargo check`。
- **严格自检是本地纪律，不是 CI 门槛**：`RUSTFLAGS="-D warnings" cargo check`——CI 未设这条，
  warning 不会挂构建；unused import 之类提交前自己清掉。

---

## 3. 服务管理（systemd）

三个 systemd 服务，均开机自启：

| 服务 | 重启策略 | 说明 |
|---|---|---|
| Rust 后端 | `Restart=always` | 工作目录即仓库根，环境文件由 dotenv 从工作目录加载 |
| Python Agent | `Restart=always` | uvicorn 2 workers 绑回环；`TimeoutStopSec=120` 让在途对话优雅结束 |
| IoT device-service | `Restart=on-failure` | 独立目录与独立仓库，不在博客仓库内 |

- **agent 无状态，重启安全**：改技能/工具/prompt 后**必须重启才生效**——push 不等于部署
  （CI 只做校验，运行时是另一件事）。
- **勿再 nohup 裸跑** Rust/agent（历史遗留习惯）：会与 systemd 抢端口，而且重启后无人拉起。
- `Restart` 计数就是崩溃次数，`systemctl status` 看它比翻日志快。
- 二进制替换由部署脚本完成（`cp → chmod +x → restart`）；前端 dist 解压即生效，不必重启 nginx。

---

## 4. 日志体系（分组规范）

`logs/` 是集中日志区，按组分层：

```
logs/
├── rust.log            # Rust：全局 access 行（method= path= status= ms=）+ 业务日志
├── agent/              # agent.log 生命周期（tid= trace_id 前缀）
│   └── traces/         # 对话 trace JSON，按天分目录 <YYYYMMDD>/（节点事件 + 分段耗时 + 退出原因）
├── frontend/           # monitor.log 前端错误上报（匿名可写，8KB body 上限）
├── device.log          # IoT device-service
├── deploy.log          # CI 触发记录
├── health.log          # 心跳探针告警
└── archive/            # 历史归档
```

- **轮转**：daily + rotate 14 + compress + copytruncate（追加写，免重启），glob 覆盖各组。
  ⚠️ **必须指定 `su ubuntu ubuntu`**：日志属主得是跑服务的那个用户，systemd 迁移后 root 属主
  会让轮转**静默失败**（20260830 踩过，chown 修正）。
- **traces 不归 logrotate 管**：对话 trace 是**文件名唯一的一次性 JSON**，而 logrotate 的 `rotate N`
  靠同名文件后缀 +1 计数，对这类文件完全无效（配置写了 `rotate 14`，实测最老文件 26 天、
  `.2.gz` 为 0 个）。该块 20260925 已整块删除；保留期改由 `eval/trace_retention.py` 执行
  （按 mtime：>24h 压缩、>30 天删除；默认只列不删，`--apply` 才动手）。
- **时区**：Rust 与 agent 日志统一本地 +08:00 钟面，跨文件对账没有 8 小时差。
- **心跳探针**（cron 每分钟，`scripts/healthcheck.sh`）：① Rust 存活 ② agent `/health` 的
  `agent_ready` ③ **uvicorn worker 崩溃检测**（pid 集合对比——worker 静默死亡不留任何日志，
  2026-08-29 事故根因）④ nginx error.log 增量扫描 ⑤ 残留无头浏览器清理。异常追加 `health.log`。
- **排障首选 trace**：对话异常直接读 trace 的分段耗时（planner / execute / model / gate），
  比翻日志快得多。

---

## 5. 配置面（说什么，不说值）

| 配置面 | 承载什么 |
|---|---|
| Rust 环境文件 | 数据库连接串（含 `timezone("+08:00")`）、`JWT_SECRET`、agent 地址、模型 API key |
| Agent 环境文件 | LLM provider/model、思考开关、trace 目录、代签 IoT JWT 的密钥 |
| device-service 环境文件 | MQTT broker、日志文件、JWT 校验侧配置 |
| nginx 站点配置 | 443 两个 server（主域 + 泛域）、缓存与 SSE 透传规则 |

约定：模板进仓库（`.env.example`），真值只在服务器上。**别在 sites-enabled 里放备份文件**——
nginx 会把它们一起加载，导致 duplicate server；备份移出该目录。

---

## 6. 故障排查手册

| 症状 | 排查路径 |
|---|---|
| 对话无响应/卡死 | ① agent `/health`（`agent_ready`？）→ ② agent 日志的生命周期行（end reason：超时/断连/错误）→ ③ trace 分段耗时（模型慢？工具挂？）→ ④ `grep 慢调用` |
| 页面白屏/看板娘不出现 | ① nginx error.log（探针已盯）→ ② 前端 monitor.log 的 js_error/fetch_fail → ③ `?v=` 没同步、浏览器吃了旧缓存 |
| Rust 崩溃自愈但反复重启 | `systemctl status` 的 Restart 计数 + rust.log 尾部（panic / DB 连接失败） |
| 设备离线/指令无效 | ① device-service 日志（入队→发出→broker 确认三段）→ ② EMQX 状态 → ③ 设备端 cmd_history 回执（req_id 对账） |
| worker 静默死亡 | health.log 的 pid 对比告警 + uvicorn master 进程树（worker 是 `spawn_main` 子进程） |
| 日志不轮转 | 查属主（必须是跑服务的那个用户）+ `logrotate -d` 干跑验证 |

**四端日志对账**：`trace_id`（`X-Request-Id`）贯穿 前端 → Rust → Python → device-service → ESP32
回执，一个 id 串起全部端日志——排障先按 trace_id 找全链路，再谈别的。

---

## 7. 安全要点

- **登录密码 Argon2id**（PHC 串 + 随机盐，OWASP 推荐档参数）；旧的无盐 SHA-256 只作**兼容校验**，
  登录成功后惰性升级该行——当初为了不把存量账号锁在门外才这么设计。
- JWT HS256（`sub` = 用户 id）；**服务间另有身份断言**：Rust 以同一密钥签一条 60 秒短时效、
  `aud=agent` 的断言放请求头，agent 验签后**覆盖请求体里的 `user_id`**——身份边界从「只听回环」
  挪进了签名里（见 [security-boundary.md](security-boundary.md)）。
- 前端错误上报端点匿名可写（访客错误上报最有价值），防刷靠 8KB body 上限 + logrotate 兜底磁盘。
- IoT API 全部校验博客 JWT（控制台复用前端已有 token，无二次登录）。
- 中转桶密钥与模型 API key 均从 CI Secrets / 环境文件注入，无硬编码；泄漏过的密钥已滚动。
