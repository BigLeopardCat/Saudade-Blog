# Saudade Blog（泠月喵的博客）

AI 看板娘博客系统：**Rust 高性能后端 + React 前端 + LangGraph AI 对话 Agent（看板娘"泠月喵"）+ ESP32 IoT 设备平台**。
生产环境 https://saudade.site（本机即生产服务器：`/home/ubuntu/memory_blog_rust`）。

## 🛠️ 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| **后端** | Rust（Axum + SeaORM + MySQL 8） | :3000，聊天转发 + 博客主流量，全局 access 日志 |
| **前端** | React 18 + Vite 5 + Ant Design 5 + Bytemd | `frontend/`，SPA + 看板娘（Live2D） |
| **AI Agent** | Python FastAPI + 手写 LangGraph（planner → model → tools → reflector） | `saudade-blog-agent/`（独立 git 仓库，:8010），对话生成 + 博客查询 + 导航/特效/夜间命令 |
| **IoT** | EMQX MQTT + device-service（Rust） | ESP32 OLED 屏幕显示/查询，MQTT over TLS（:8883）|
| **部署** | GitHub Actions CI → R2 → 服务器脚本 | 云端构建，本机 systemd 托管 |

## 📂 目录结构

```text
memory_blog_rust/
├── src/                  # Rust 后端（routes/ 路由、entity/ 实体、middleware/）
├── frontend/             # React 前端（public/live2d-widgets 看板娘 + 聊天面板）
├── saudade-blog-agent/   # ★ Python Agent（独立仓库，gitignore 排除，改动后重启服务生效）
├── scripts/              # deploy（部署脚本）+ healthcheck.sh（心跳探针）
├── logs/                 # 日志（分组，见下方）
└── .github/workflows/    # deploy.yml：push → 云端构建 → R2 → SSH 触发部署
```

## 🚀 开发与部署

### 环境准备
```bash
cp .env.example .env      # DATABASE_URL 等（.env 不进 git）
cargo check               # 本机最多做轻量验证
```

### ⚠️ 部署约定（20260830 起）
**部署一律走 CI——本机不编译、不手动构建**。机器仅 3.7GB 内存，`vite build`（3GB 堆）+ 常驻服务会 OOM 甚至拖垮整机（20260830 实际发生）。流程：

```text
git push cn_sora_blog → GitHub Actions 云端构建（Rust + 前端）
  → 上传 R2 → SSH 触发 scripts/deploy/deploy_from_r2.sh
  → 二进制替换 + systemctl restart saudade-rust；dist 直接覆盖
```

`scripts/deploy/upload_to_r2.py` 手动部署仅作 CI 故障逃生通道。

### 服务管理
- `saudade-rust`（:3000 博客后端）、`saudade-agent`（:8010 AI agent）、`saudade-device`（:3100 IoT）、EMQX（MQTT :8883/1883）、nginx（80/443）
- 探针 `scripts/healthcheck.sh`（cron 每分钟）：存活检查 + uvicorn worker 崩溃检测 + nginx error.log 增量扫描 → `logs/health.log`

## 📊 日志体系（20260830f 起按组分层）

```text
logs/
├── agent/      # ★ agent 组：agent.log + traces/（对话执行 trace JSON，排障首选）
├── frontend/   # ★ 前端组：monitor.log（前端 JS 异常/API 失败上报，全量——仅同 key 会话去重）
├── rust.log    # 后端（含全局 access 行 http method= path= status= ms=）
├── health.log  # 探针
├── deploy.log  # CI 部署触发
├── device.log  # IoT 设备服务
└── archive/    # 轮转归档
```

按日轮转由 `/etc/logrotate.d/saudade` 负责（daily + rotate 14 + gzip + copytruncate）。

## 🔌 API 全览（均返回 `{ code, message, data }`）

### 公开接口
| 模块 | 方法 | 路径 |
|------|------|------|
| Auth | POST | `/api/login` |
| Note | GET/POST | `/api/public/notes`（列表/搜索/详情/置顶） |
| Category/Tag | GET | `/api/category`、`/api/tagone`、`/api/tagtwo` |
| Friend/Talk | GET | `/api/friends`、`/api/talk`、`/api/public/board`（留言板公开可写） |
| User/Social | GET | `/api/public/user`、`/api/public/social` |
| **Chat** | POST | `/api/chat/stream`（SSE 对话，看板娘） |
| Monitor | POST | `/api/monitor/log`（前端错误上报，匿名可写，body 8KB 上限） |

### 保护接口（需 JWT）
| 模块 | 方法 | 路径 |
|------|------|------|
| Note | POST/DELETE | `/api/protected/notes`（创建/更新/批量删除） |
| Image | POST/DELETE | `/api/protect/upload`、`/api/protect/delImg`（上传管理） |
| Category/Tag/Friend/Talk | POST/DELETE | `/api/protected/*` |
| Social | PUT | `/api/protected/social` |
| 设备 | * | `/api/device-api/*`（nginx → device-service :3100，服务端校验 JWT） |

### 看板娘（Live2D）
浏览器加载 `frontend/public/live2d-widgets/`（autoload.js 入口 + 聊天面板 + cubism5 运行时）。
**nginx 对 live2d-widgets 目录 immutable 缓存 1 年**——子模块变更须 bump 版本号
（autoload.js `VER` + `Live2dAgent/index.tsx` `?v=`），waifu-tips 模块图变更须整体重命名（详见 CLAUDE.md §1）。

## ✅ 测试与质量
- Agent：`test_skills.py`（L0 秒级）+ `eval/run_golden.py`（L2 真实 LLM 端到端），nightly cron 自动跑
- 探针/日志体系：`scripts/healthcheck.sh` + 前端错误上报闭环

## 📄 许可
GPL-2.0
