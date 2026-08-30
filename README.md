# Saudade Blog — 泠月喵的博客 🐱

一个**会陪你聊天的 AI 看板娘博客**：Rust 博客 + Live2D 看板娘 + ESP32 物联网，三个系统协同运行。
生产环境：<https://saudade.site>

看板娘"泠月喵"不只是静态立绘——她能回答关于博客内容的问题、按你的话跳转页面、开关樱花/星空特效、
切换夜间模式，甚至把内容推送到你手边的 ESP32 OLED 小屏上。她的"大脑"是一个独立部署的 Python
Agent（手写 LangGraph 图：planner → model → tools → reflector），对话记忆全部外置 MySQL，
**agent 本身无状态**——每次请求都是新线程，连续性靠后端注入历史与摘要。

## 架构一览

```
浏览器（React SPA + Live2D 看板娘）
  │  HTTPS /api/chat/stream（SSE 流式对话）
  ▼
nginx（静态资源 + 反代 + JWT 校验 + MQTT WSS）
  ├── Rust 后端 :3000 ────────── Python Agent :8010
  │    博客 API / 登录鉴权        手写 LangGraph 图
  │    聊天转发 / 记忆入库        planner 选技能 → 模板执行 → 质检
  └── device-service :3100 ── MQTT over TLS :8883 ── ESP32 OLED 设备
```

| 组件 | 职责 | 位置 |
|---|---|---|
| **Rust 后端**（Axum + SeaORM + MySQL 8） | 博客主流量（文章/分类/标签/友链/留言板）、登录鉴权（JWT）、聊天链路中枢（鉴权 → 历史入库 → SSE 逐帧转发） | `src/` |
| **前端**（React 18 + Vite + antd + bytemd） | SPA；看板娘与聊天面板由 `live2d-widgets/`（autoload.js 入口，纯 JS 子模块拆分）驱动 | `frontend/` |
| **AI Agent**（FastAPI + 手写 LangGraph） | 看板娘大脑：对话生成、博客查询、导航/特效/夜间命令、IoT 设备显示。**独立 git 仓库** | `saudade-blog-agent/` |
| **IoT**（EMQX 5 + Rust device-service） | ESP32 设备接入（MQTT over TLS）、OLED 显示、设备控制台（`/device-console/`） | `/home/ubuntu/mqtt-demo/` |

Agent 的核心理念是**技能注册表 + 受限规划**：固定流程任务（导航/特效/夜间/设备显示）落地为
`skills.py` 里的静态技能定义，planner 只负责"选技能 + 填参数"，executor 按模板执行，reflector
对照模板质检——模型"假装执行"过不了模板比对。记忆方面，模型对记忆**无写权限**：滚动摘要由
后端独立任务生成。详细架构见 [agent 仓库](https://github.com/BigLeopardCat/saudade-blog-agent)
的 README 与 `docs/agent-architecture.md`。

## 开发流程（重要约定）

> ⚠️ 本机既是开发机也是生产服务器，**部署一律走 CI，本机不编译、不手动构建**——机器仅
> 3.7GB 内存，20260830 曾因本地 `vite build` 内存不足拖垮整机。本地验证只用轻量命令。

```text
git push（主仓库 cn_sora_blog / agent 仓库）
  → GitHub Actions 云端构建（Rust 编译 + 前端打包；agent 另有评测门禁）
  → 上传 R2 → SSH 触发 scripts/deploy/deploy_from_r2.sh
  → 二进制替换 + systemctl restart；dist 直接覆盖
```

按组件：

- **后端（本仓库 `src/`）**：本地只做 `RUSTFLAGS="-D warnings" cargo check`（与 CI 严格模式
  对齐——unused import 等任何 warning 都会挂构建），push 即由 CI 编译部署。
- **前端（本仓库 `frontend/`）**：本地不构建。改动 push 走 CI；**改了 live2d-widgets 子模块
  必须 bump 版本号**（nginx 对该目录 immutable 缓存 1 年：`autoload.js` 的 `VER` 与
  `Live2dAgent/index.tsx` 的 `?v=` 同步，waifu.css 的 `?v=` 用 VER 自动）。
- **Agent（`saudade-blog-agent/`，独立仓库）**：改技能/工具/prompt 后需重启服务生效
  （`sudo systemctl restart saudade-agent`）；push 走独立 CI。改技能注册表 / plan 契约 /
  摘要逻辑后必跑 `test_skills.py`（L0）与 `eval/run_golden.py`（L2 真实 LLM 端到端）。

## 部署与运维

服务均为 systemd 托管（`Restart=always` 崩溃自愈）：

| 服务 | 端口 | 说明 |
|---|---|---|
| `saudade-rust` | :3000 | 博客后端 |
| `saudade-agent` | :8010 | AI 看板娘（2 workers；`TimeoutStopSec=120` 优雅停等在途对话） |
| `saudade-device` | :3100 | IoT 设备服务（源码在 mqtt-demo，**不经 CI**，改后手动构建重启） |
| nginx / EMQX | :443 / :8883 | 入口 / MQTT over TLS（8883 是唯一对公网开放的设备端口） |

日志统一在 `logs/`，按组分层（logrotate 按日轮转，14 天归档）：

- `logs/agent/` —— **agent 组**：agent.log + `traces/`（每轮对话的节点耗时 trace JSON，排障首选）
- `logs/frontend/` —— **前端组**：monitor.log（浏览器 JS 异常 / API 失败自动上报，全量仅去重）
- `logs/` 根 —— 后端组：rust.log（含全局 access 行）、health.log（探针）、deploy.log（CI 触发）、device.log

探针 `scripts/healthcheck.sh`（cron 每分钟）：服务存活检查 + uvicorn worker 崩溃检测 +
nginx error.log 增量扫描，异常追加 health.log。

## 给贡献者

- **新增 Agent 工具**：在 `tools/base.py` 用 `@tool` 定义并加入 `_TOOL_REGISTRY`；若服务于
  固定流程任务，**必须**在 `skills.py` 注册对应技能（触发条件 + 工具序列模板 + 回复契约），
  否则 planner 无法可靠选择它——这是 agent 的核心约定。
- **接口一览**：公开（登录、文章/分类/标签/友链/留言板、聊天 SSE `/api/chat/stream`、
  前端监控上报 `/api/monitor/log`）；受保护（JWT：内容增删改、图片上传、`/device-api/*`）。
- **SSE 帧协议**：`\n\n` 分隔 + JSON 编码；命令帧（导航/特效/夜间）、`__PROCESS__` 过程轨迹、
  `__RESET__` 否定轮清屏、`__END__` 结束。改协议三端（Python/Rust/前端）同步。
- **开发约定与已知坑**（时区、模型行为边界、断连中断机制等）见 [CLAUDE.md](CLAUDE.md)。

## 许可

GPL-2.0
