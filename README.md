# Saudade Blog

个人博客系统。Rust 后端、React 前端、独立的 Python 对话 Agent，以及一个 Live2D 看板娘。
另有一套可选的 ESP32 物联网接入（不装不影响其余部分，见 [iot/](iot/)）。

示例站点：<https://saudade.site>

看板娘"泠月喵"可以回答关于站内文章的问题、跳转页面、开关页面特效、切换夜间模式；
接入物联网后还可以把内容推送到 ESP32 的 OLED 屏上。她的对话能力来自一个独立部署的
Python Agent（手写 LangGraph 图：**planner ⇄ execute → model → gate**）。对话记忆全部外置
MySQL，agent 进程本身无状态：每次请求都是新线程，连续性由后端注入历史与摘要维持。

首页另有一件展品：**文章向量空间图谱**。它把 7 篇文章抽出的 400 个关键词按 embedding 投到
三维空间，点是词、相关的词之间连线，可拖动视角、双击词跳转文章，也能在下方输入框里做
**向量检索**定位。它与对话是两条独立的检索线：图谱查询走 1024 维精确余弦（纯 Python 点积），
agent 问答走词法 BM25（语料小、机器内存受限）。细节见 [docs/word-graph.md](docs/word-graph.md)。

## 架构一览

```
浏览器（React SPA + Live2D 看板娘）
  │  HTTPS /api/chat/stream（SSE 流式对话）
  ▼
nginx（静态资源 + 反代 + MQTT WSS；JWT 校验在 Rust 侧）
  ├── Rust 后端 :3000 ────────── Python Agent :8010
  │    博客 API / 登录鉴权        手写 LangGraph 图
  │    聊天转发 / 记忆入库        planner 决策 ⇄ execute 确定性执行 → model 叙述 → gate 检查
  └── device-service :3100 ── MQTT over TLS :8883 ── ESP32 OLED 设备
```

| 组件 | 职责 | 位置 |
|---|---|---|
| **Rust 后端**（Axum + SeaORM + MySQL 8） | 博客主流量（文章/分类/标签/友链/留言板）、登录鉴权（JWT）、聊天链路中枢（鉴权 → 历史入库 → SSE 逐帧转发） | `src/` |
| **前端**（React 18 + Vite + antd + bytemd） | SPA；看板娘与聊天面板由 `live2d-widgets/`（boot.js 入口，纯 JS 子模块拆分）驱动 | `frontend/` |
| **AI Agent**（FastAPI + 手写 LangGraph） | 看板娘大脑：对话生成、博客查询、导航/特效/夜间命令、IoT 设备显示。**独立 git 仓库** | `saudade-blog-agent/` |
| **IoT**（EMQX 5 + Rust device-service） | ESP32 设备接入（MQTT over TLS）、OLED 显示、设备控制台（`/device-console/`）。**可选件**，出厂默认不启用 | `iot/`；服务本体不在本仓，见 [iot/device-service/README.md](iot/device-service/README.md) |

Agent 的核心理念是**把执行层的自由拿掉**（20260903 架构裁决，自由 ReAct / LLM 质检 / 重考轮
已废除）。固定流程任务（导航/特效/夜间/设备显示）落地为 `skills.py` 里的静态技能定义：
**planner 是唯一决策者**（选技能 + 填参数 + 产出调用清单），**execute 是确定性执行器**
（照单执行，无授权分支、无自由意志），每条执行再经 checker 验收（PASS 才成为系统确认事实），
最后 **model 零工具叙述**（结构上发不出工具调用）、**gate 确定性检查**叙述是否失真。
于是"模型假装执行"在拓扑上不可能发生。记忆方面，模型对记忆**无写权限**：滚动摘要由后端
独立任务生成。详细架构见 [agent 仓库](https://github.com/BigLeopardCat/saudade-blog-agent)
的 README 与 `docs/agent-architecture.md`。

## 开发流程（重要约定）

> 本机既是开发机也是生产服务器，**部署一律走 CI，本机不编译、不手动构建**。机器仅 3.7GB
> 内存，20260830 曾因本地 `vite build` 内存不足拖垮整机。本地验证只用轻量命令。

```text
git push（主仓库 cn_sora_blog / agent 仓库）
  → GitHub Actions 云端构建（Rust 编译 + 前端打包；agent 另有评测门禁）
  → 上传 R2（按提交号归档 deploy/<sha>/）→ SSH 触发部署并**等它结束**（退出码 = 部署结果）
  → 二进制替换 + systemctl restart；dist 直接覆盖
```

按组件：

- **后端（本仓库 `src/`）**：本地只做 `RUSTFLAGS="-D warnings" cargo check`（严格自检；
  CI 未设 RUSTFLAGS，warning 不挂构建——此模式是本地纪律，不是 CI 门槛），push 即由 CI 编译部署。
- **前端（本仓库 `frontend/`）**：本地不构建，改动 push 走 CI。看板娘前端（`live2d-widgets/`）
  的缓存版本号有**多点同步**要求，改动前先读
  [frontend/README.md](frontend/README.md) 的《改这里的文件要 bump 版本号》一节——
  那里是同步点的唯一清单，本文不重复列举。
- **Agent（`saudade-blog-agent/`，独立仓库）**：改技能/工具/prompt 后需重启服务生效
  （改完要重启 agent 服务才生效）；push 走独立 CI。改技能注册表 / plan 契约 /
  摘要逻辑后必跑 `test_skills.py`（L0）与 `eval/run_golden.py`（L2 真实 LLM 端到端）。

## 部署与运维

服务均为 systemd 托管（agent/rust 为 `Restart=always` 崩溃自愈；device 为 `Restart=on-failure`）：

| 服务 | 端口 | 说明 |
|---|---|---|
| Rust 后端 | :3000 | 博客 API + 对话编排 |
| Python Agent | :8010 | AI 看板娘（2 workers；`TimeoutStopSec=120` 优雅停等在途对话） |
| IoT device-service | :3100 | 设备服务（源码在独立目录，**不经 CI**，改后手动构建重启）。仅启用 IoT 时存在 |
| nginx / EMQX | :443 / :8883 | 入口 / MQTT over TLS（8883 是唯一对公网开放的设备端口）。EMQX 同理 |

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
  前端监控上报 `/api/monitor/log`）；受保护（JWT：内容增删改、图片上传、`/device-api/*`、
  **图谱检索 `/api/public/graph/query`**——要求登录，防匿名刷 embedding 调用）。
- **SSE 帧协议**：`\n\n` 分隔 + JSON 编码；命令帧（导航/特效/夜间）、`__PROCESS__` 过程轨迹、
  `__RESET__` 否定轮清屏、`__SUMMARY__` 摘要回流、`__END__` 结束。改协议三端（Python/Rust/前端）同步。
- **设计与文档索引**（`docs/`）：
  [部署与运维手册](docs/deployment-and-ops.md)（拓扑端口 / CI-CD / systemd / 日志 / 排查）、
  [安全边界与加固](docs/security-boundary.md)（信任边界、输入限额、已知缺口）、
  [向量图谱](docs/word-graph.md)（选词 / 降维 / 布局 / 检索的完整实测记录）、
  [IoT 设备接入](docs/iot-device-integration.md)。
- **Agent 侧机制**（模型行为边界、断连中断、防幻觉闸、评测体系）见
  [saudade-blog-agent](https://github.com/BigLeopardCat/saudade-blog-agent) 的 `docs/`。
- **第三方组件与许可**：[THIRD-PARTY.md](THIRD-PARTY.md)。

## 许可

本仓库以 **GPL-2.0** 分发，全文与版权声明见 [LICENSE](LICENSE)。
第三方组件及其许可见 [THIRD-PARTY.md](THIRD-PARTY.md)。

### 看板娘前端（不在本仓）

看板娘前端（`live2d-widgets/` 与 `live2d_model/`：渲染层、聊天面板、模型与贴图）不在本仓，
它住在 agent 仓。本仓构建时按 `frontend/widget.lock.json` 里钉死的提交号把它取回来打进产物，
路径与从前完全相同，因此服务端与测试零改动。

这棵树的许可分两半，边界按"文件是代码还是美术"划，与目录结构无关：

- **代码**（`boot.js` / `renderer.js` / `chat-*.js` / `widget.css` 等）以 **MIT** 分发，可商用。
  版权与许可声明照录于本节末尾，MIT 要求它随分发一起带上。
- **美术资源**（`live2d_model/agent_2.*` 模型与贴图、`lingyue-toggle.png` 面板图标，以及
  「泠月喵」这个**形象设计本身**）以 **CC BY-NC-SA 4.0** 分发（署名 · 非商业性使用 ·
  相同方式共享）：可以自用、可以改，**不可商用**，改作必须以同样协议分发。全文见 agent 仓的
  [frontend/ASSETS-LICENSE.md](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/frontend/ASSETS-LICENSE.md)。
  需要留意的是它**不是** OSI 意义上的开源许可，这一部分属于"源码可用"：fork 出去做**商业**
  站点时不能带这套美术，把 `live2d_model/` 换掉即可；代码那一半仍是 MIT。

### MIT 全文（适用于看板娘前端的代码）

```
MIT License

Copyright (c) 2026 BigLeopardCat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
