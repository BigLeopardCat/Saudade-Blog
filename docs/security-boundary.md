# 服务信任边界与加固（20260916）

这份文档回答一个被反复问到的问题：**这套系统里，谁信谁？边界画在哪？**

写给两类读者：接手的人（知道哪一层能改什么），以及面试/评审时被追问"你的服务间鉴权呢"的时候
——本文里的每一条都是**在这台机器上实测**的，不是设计意图。

## 1. 拓扑：谁能碰到谁

```
公网 ──TLS──► nginx :443 ──► Rust 后端 :3000 (127.0.0.1) ──► Python agent :8010 (127.0.0.1)
                    │                                              ▲
                    └─ 静态 dist（含图谱产物 graph/*.js）           │
                       ① 公开读，无鉴权                               │
                                                        device-service :3100 (127.0.0.1)
```

三条硬事实（都实测过）：

1. **只有 nginx 暴露在公网**。Rust（`main.rs`）与 agent（uvicorn `--host 127.0.0.1`）都只绑回环。
2. **nginx 不代理 agent 8010**——`/etc/nginx/sites-enabled/blog` 里对 8010 零匹配。
   想从公网碰 agent，只有"经 Rust"这一条路。
3. `device-service`（IoT，源码在 `/home/ubuntu/mqtt-demo/`，不在 git）同样只绑回环，
   由 nginx 的 `/device-api/*` 反代，**它自己校验博客 JWT**。

## 2. 谁在鉴权、谁没有（逐端点）

| 入口 | 鉴权在哪 | 判据 | 实测失败形态 |
|---|---|---|---|
| `/api/chat`、`/api/chat/stream` | Rust | JWT（HS256 / `JWT_SECRET`） | 401 |
| `/api/public/graph/query` | Rust | **要求登录**（防匿名刷 embedding 调用） | 401 `{"ok":false,"reason":"login_required"}` ← 匿名 curl 实测 |
| `/api/public/notes*` 等公开读 | 无（有意公开） | — | 200 |
| agent `/chat`、`/chat/stream`、`/review`、`/graph/query` | **无** | 信任前提 = "来自本机" | 任何本机进程都能调 |

**agent 侧为什么可以没有鉴权**：它只听回环，公网到不了；能调它的只有同机的 Rust 与
（理论上）本机的其他进程。这是**单机部署下的有意取舍**，不是漏做——但必须写下来，
因为它的含义是："**能在这台机器上执行命令的人 = agent 的全权限**"。

> ⚠️ 一旦 agent 要跨机部署（或容器网络不再是 loopback），这条假设立刻失效，
> 第一件事就是加服务间凭据（见 §6 待办）。

## 3. 传输安全

- **agent → 外部 HTTP**：`tools/base.py` 的共享 `httpx.Client` 使用**默认的 TLS 校验**
  （20260916 修：原为 `verify=False`）。这个 client 不只打自家站点公开 API，还打**第三方**
  `https://wttr.in`（天气工具），关校验等于给第三方响应体开了一道中间人口子——而响应会进 prompt。
  两个域名的证书链都正常（实测 `verify=True` 均 200），所以关校验从来不是"必需"。
  `test_hardening.py` 里有一条断言盯着 SSLContext 的 `verify_mode == CERT_REQUIRED`。
- **IoT 链路**：设备侧 `mqtts://saudade.site:8883`（TLS），`device-api` 复用的就是博客 JWT。
- **Rust → agent**：回环 HTTP（不加密）。与本条边界假设一致：回环不设防。

## 4. 输入限额（20260916 新增，`server.py`）

输入全部经 Rust 转发（回环 + 已鉴权），所以限额防的**不是陌生人**，而是：前端出 bug 塞了畸形请求、
被塞超长字段白烧 token、本机进程乱调把 worker 拖垮。

| 位置 | 上限 | 理由 |
|---|---|---|
| 请求体（Content-Length） | 12 MB → **413** | starlette **默认不限制** body 大小，畸形大包在解析前就吃内存（本机 3.7 GB） |
| `message` | 4000 字符 | 正常提问 < 500 |
| `history` | 60 条 | Rust 实际发 20~21 条（实测 trace `history_len=20`），留 3 倍余量 |
| 图片 | 最多 6 张、单张 ≤1.6M 字符 | 前端压缩后单图 ≤1MB，base64 后 ≈1.37M；dataURL 直接进 prompt |
| `summary` / `executions` | 8000 字符 | 注入文本，防越灌越长 |
| `current_url` / `page_title` / `effects` / `darkmode` | 500 字符 | 都是短标量 |
| `/graph/query` 的 `q` | 128 字符 | 前端本就截到 64（`locate.ts QUERY_MAX`） |
| 并发流（每 worker） | 8 → **503**（排队 3s 仍拿不到） | LLM 流是最贵资源（单次最长 180s）；无闸时并发只会一起排队到超时 |

落点：字段级是 Pydantic `Field`/`field_validator`（`ChatRequest`、`GraphQueryRequest`），
体积是 `body_limit_middleware`，并发是 `_try_acquire_slot`（槽位由 `/chat/stream` 的生成器
`finally` 归还，所有退出路径都经过那里）。

## 5. 协作取消（stop_event）的能力边界

- 机制：客户端断开 → starlette 取消流任务 → `stop_event` 置位；agent 图在**循环级**（producer
  每次迭代）与**节点级**（planner/execute/reflector/model/gate 开头）检查，命中即抛
  `AgentCancelled`。
- **能力边界（重要）**：`model` 等节点的 LLM 调用**本身不可打断**——最坏要等一次 LLM 超时
  （`llm_timeout=120s`）才轮到下一次检查。但**下一个检查点一定拦得住**，所以"用户走了还在写
  设备"这件事不会发生。
- 写操作安全：`execute` 在**调用工具之前**检查取消（节点入口 + **逐 spec**，20260916 补——此前
  只在入口检查一次，`[导航, 屏显]` 这类多写操作清单在中途断连时会把屏显也写掉）。中途取消用
  `break` 而不是 `raise`：已执行项的**回执必须留下**（那是真发生过的事实）。
- 文档：`docs/问题记录.md` 有完整的事故与机制记录；针对性回归见
  `saudade-blog-agent/test_cancel.py`（节点入口检查 / 写操作零调用 / 中途取消 / LLM 阻塞期间
  取消的能力边界，共 14 条）。

## 6. 已知缺口（如实列，不假装覆盖）

| 缺口 | 影响 | 现状 |
|---|---|---|
| 没有**按用户/IP 的限流** | 单个已登录用户可以连续发起对话占满并发槽 | Rust 侧也没有；只有总并发闸 |
| **分块传输**（无 Content-Length）不过体积闸 | 构造性的大 body 能绕过 §4 的第一行 | 只靠字段级限额兜，已写在代码注释里 |
| agent 端点**无服务间凭据** | 本机任意进程可调（含 `/chat/stream`） | 依赖回环边界；跨机部署前必须补 |
| 工具错误只分了**两类**（empty / unavailable），没有统一错误码枚举 | 想按错误类型做重试策略（超时 vs 鉴权失败）时还得读文案 | 20260916 已落地两类 + checker 的 `unavailable` 受阻码；更细的分类按需再加 |

已完成（20260916，留档说明为什么值得做）：
- **协作取消有针对性测试**：`test_cancel.py` 把"取消后不写设备"从"结构保证"变成"回归锁住"；
  写它的时候顺带发现并修掉了逐 spec 检查缺失（多写操作清单中途取消会把剩下的写操作执行完）。
- **工具错误分了两类**：`ToolResult`（str 子类，带 `kind`）+ `_get` 失败不再返回 `[]`；
  checker 对 `unavailable` 判 BLOCK——**"服务挂了"不再作为事实进入跨轮执行记忆**（此前
  "查询设备列表失败: Connection refused" 会被记成 receipt，下轮质疑"你查到了什么"时
  agent 会照着故障回执编）。

## 7. 怎么验证（都可复现）

```bash
# ① 公网到不了 agent：nginx 不代理 8010
grep -c 8010 /etc/nginx/sites-enabled/blog            # → 0

# ② 图谱检索的登录闸在 Rust 层（匿名应得 401 login_required）
curl -s -X POST https://saudade.site/api/public/graph/query \
     -H 'Content-Type: application/json' -d '{"q":"物联网"}'

# ③ 加固单测（TLS 校验 / 输入限额 / 请求体积 / 并发闸）
cd saudade-blog-agent && .venv/bin/python test_hardening.py

# ④ agent 端点的鉴权事实：本机直连成功（回环 = 边界）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8010/graph/query \
     -H 'Content-Type: application/json' -d '{"q":"物联网"}'   # → 200
```
