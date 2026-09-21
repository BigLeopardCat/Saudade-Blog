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
2. **nginx 不代理 agent 8010**——本机 nginx 站点配置里对 8010 零匹配。
   想从公网碰 agent，只有"经 Rust"这一条路。
3. `device-service`（IoT，源码在独立目录、不在本仓库）同样只绑回环，
   由 nginx 的 `/device-api/*` 反代，**它自己校验博客 JWT**。

## 2. 谁在鉴权、谁没有（逐端点）

| 入口 | 鉴权在哪 | 判据 | 实测失败形态 |
|---|---|---|---|
| `/api/chat`、`/api/chat/stream` | Rust | JWT（HS256 / `JWT_SECRET`） | 401 |
| `/api/public/graph/query` | Rust | **要求登录**（防匿名刷 embedding 调用） | 401 `{"ok":false,"reason":"login_required"}` ← 匿名 curl 实测 |
| `/api/public/notes*` 等公开读 | 无（有意公开） | — | 200 |
| agent `/chat`、`/chat/stream`、`/review`、`/graph/query` | **无**（回环）＋ 身份断言 | 信任前提 = "来自本机"；Rust 另签一条 60s 断言声明"这个 uid 是认证过的" | 任何本机进程都能调 |

**agent 侧为什么可以没有鉴权**：它只听回环，公网到不了；能调它的只有同机的 Rust 与
（理论上）本机的其他进程。这是**单机部署下的有意取舍**，不是漏做——但必须写下来，
因为它的含义是："**能在这台机器上执行命令的人 = agent 的全权限**"。

### 2.1 服务间身份断言（20260917 落地，20260920 加角色）

上面那条"回环即信任"的假设，在**身份**这一维已经不用再靠它兜：Rust 每次转发对话时用同一个
`JWT_SECRET` 签一条短时效断言（`aud="agent"`、60 秒、`X-Agent-Assertion` 头），agent 验签通过
后**用断言里的 uid 覆盖请求体里的 `user_id`**——直连 agent 的人伪造不出别人的身份。

- 判据在 agent `server.py::_verify_assertion_claims`（手写 HS256 校验，只依赖标准库）；
- **默认仍是"缺头只记 WARNING、行为不变"**（`AGENT_REQUIRE_ASSERTION=0`）：打开它会让
  不带断言的调用方直接 401，所以按滚动上线处理——Rust 先部署，再开开关；
- **20260920 起断言里多一个 `role`**（取自 DB 的 `user.role`，不信登录 token 里可能是
  7 天前的角色）：agent 侧据此做**能力判据**（见 `saudade-blog-agent/docs/secretary.md`）。
  角色缺失/未知 = **零权限**，由 agent 的 shadow 模式先观测不拦截。

⚠️ 这条断言只解决"**uid 是不是真的**"，不解决"**这台机器上谁能调 agent**"（回环边界照旧）；
一旦 agent 要跨机部署（或容器网络不再是 loopback），还是要加真正的服务间凭据（见 §6）。

### 2.2 agent → Rust 的代调通道（20260921 新增，管理助手）

上面那条是 **Rust → agent**；20260921 起反方向多了一条：agent 要读后台数据（留言审核状况、
用户统计），于是**以本轮发起人的身份**去调 `/api/protected/*`。

- **怎么代**：`tools/base.py` 用本轮的 uid 现签一条 **60 秒** HS256 JWT（payload 只有
  `sub`/`exp`/`role`，**不带 `aud`**——Rust 的 `verify_token` 用 `Validation::default()`，
  多一个 aud 会被判无效），打 `http://127.0.0.1:3000`。
- **为什么 Rust 零改动**：`middleware::auth_guard` 本来就按 `claims.sub` **查库**判角色
  （与 §2.1 同一条纪律：不信 token 里的 role）。所以 token 里的 `role` 只是日志可读，
  **没有任何权威**——伪造不了权限，能通就说明库里这个人真是 admin。
- **agent 侧还有一道**：这条通道对应的 scope 是 `admin.console`，属 `_HARD_SCOPES`——**不吃
  `AGENT_AUTHZ_ENFORCE` 的 shadow 开关**。理由：shadow 是为了观测"既有流量会不会被拦"，
  而管理助手是纯新增能力、没有观测期，shadow 期越权是可被利用的窗口。
  四个工具同时**不进 planner 点名白名单**（结构上点不到），非 admin 的 planner 上下文里
  也看不到对应技能。
- **失败取向**：401/403 → `unavailable("当前身份无权访问后台数据")`，**不返回空**——
  空结果在下游会被读成"没有待审留言"（把"没权限"说成"没问题"是这类功能最坏的失败形态）。

**这条通道带来的新注入面（必须知道）**：agent 从此会读**攻击者可控的文本**——待审留言的
正文会进入工具帧。本轮能力全是只读，注入最多导致**答错**、不导致**做错**；工具侧对这类文本
做了命令前缀消毒（`agent/reports.py::sanitize_untrusted`，在命令词与冒号之间插 U+200B 零宽
空格——它不是 Unicode 空白，Python 与 JS 的 `\s` 都不匹配，所以两侧的命令行识别一起失效，
而文本仍然可读）。**做写操作之前，§3.4 的人在回路闸必须先真正跑通**。

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
- **取消的三笔真实代价**（写下来免得被当成"零成本中断"）：
  1. **那次调用的输出被丢弃**：不入库、不显示（用户看到的是"没回复"，不是"跑完了但没给"）。
  2. **线程仍被占住**：`producer_task.cancel()` 取消不了线程池里的线程（注释原话："线程池任务
     cancel 无效"），它要等那次 HTTP 返回才释放。线程池 16 槽 ⇒ 短时间**反复**打断/刷页面会把
     槽位逐步占满，新对话开始排队。并发槽位（8/worker）不受影响：`event_stream` 的 `finally`
     在取消路径照样执行 `_release_slot()`。
  3. **token 照常计费**：取消不能回收已经发出去的那次调用。
  ⇒ 想真正掐断在途请求，得换异步 LLM 客户端 + 真取消（anyio cancel scope / httpx abort），
  属架构级改动；当前是"检查点拦住所有**下一步动作**、拦不住**正在路上的那一次请求**"的取舍。
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
| agent 端点**无服务间凭据** | 本机任意进程可调（含 `/chat/stream`） | 依赖回环边界；跨机部署前必须补。**"我代表谁"已由 §2.1 的断言解决，这条说的是"谁在调我"** |
| **写操作的事前授权只覆盖了一半** | 设备屏显等"用户眼前"的写仍然只有"调用前查断连"这道防护；**代用户写站点内容**这一类已有人在回路闸，但**还没有这样的工具**，所以闸今天空转 | 20260920 起 agent 侧落地：需确认的 scope（`CONSENT_SCOPES = {write.content}`）未获用户**本轮消息**明确确认 → 产 `__ERROR__: 待确认[consent_required]` 帧、**不调用工具**，且 gate 5a 让叙述侧无法把它说成"已完成"（`agent/authz.py` + `test_authz.py` ⑨，见 `saudade-blog-agent/docs/secretary.md` §3.4）。**剩下的**：写通道凭据（④）、"以谁的名义"的审计落库（⑥）——`execution_log` 是事后记忆，不是审批 |
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
grep -c 8010 "$NGINX_SITE"    # $NGINX_SITE = nginx 站点配置文件（路径见私有运行簿）；→ 0

# ② 图谱检索的登录闸在 Rust 层（匿名应得 401 login_required）
curl -s -X POST https://saudade.site/api/public/graph/query \
     -H 'Content-Type: application/json' -d '{"q":"物联网"}'

# ③ 加固单测（TLS 校验 / 输入限额 / 请求体积 / 并发闸）
cd saudade-blog-agent && .venv/bin/python test_hardening.py

# ④ agent 端点的鉴权事实：本机直连成功（回环 = 边界）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8010/graph/query \
     -H 'Content-Type: application/json' -d '{"q":"物联网"}'   # → 200

# ⑤ 新增的后台统计端点确实在守卫域内（无 token / 伪 token 都应 401，实测均 401）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/protected/stats/users
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer bogus.token.here' \
     http://127.0.0.1:3000/api/protected/stats/users

# ⑥ 管理助手活体探针（真打 8010，两个身份各三问；uid 由参数传，不入库）
cd saudade-blog-agent && .venv/bin/python eval/probe_admin_report.py --uid <管理员的 uid>
```
