# 首页展示柜：文章向量空间知识图谱（20260915）

首页夜间模式右侧有一片空白（`.frontDark` 下 `.heroVideo/.heroOverlay` 被 `display:none`，
布局改 `flex-start` 后又注释掉了大圆头像）。这块空白现在是一个**展示柜窗口**
（`.vitrine`），第一件展品是「文章向量空间」：把文章里抽出的关键词按 embedding
向量投到三维空间，点上写着词、相关的词连线，可拖动视角、双击词跳文章、
在下方输入框里查询定位到最近的向量。

```
frontend/src/frontHome/Content/ContentHome/Vitrine/
├── index.tsx            壳：玻璃面板 + 标题栏 + Suspense（仅夜间挂载）
├── index.sass           窗口与展品样式（⛔ 不用 backdrop-filter，见 §7）
├── exhibits.ts          展品注册表（v1 只一项，硬编码取 [0]）
└── wordgraph/
    ├── WordGraphExhibit.tsx  React 侧：画布、悬停卡片、查询框
    ├── engine.ts             零 DOM 的渲染引擎 + 投影/命中/取景纯函数
    ├── loader.ts             manifest → 动态 import 产物
    ├── locate.ts             查询：真 embedding（A）→ 本地关键词（B）
    ├── palette.ts            配色（按文章着色）
    └── types.ts              产物数据契约
```

Rust 侧 `src/routes/graph.rs`（`POST /api/public/graph/query`）→ agent `rag/wordgraph.py`
（`POST /graph/query`）→ `data/word_graph/` 里的向量产物。

---

## 1. 数据产物契约

### 1.1 前端：`frontend/public/graph/`

| 文件 | 内容 | 缓存 |
|---|---|---|
| `graph-<id>.js` | `export default {v, model, dim, built, articles[], nodes[], edges[], stats{}}` | 1 年 immutable |
| `manifest.json` | `{"v":"<id>","file":"graph-<id>.js","bytes":N}` 65 字节 | no-store |

**为什么用 `.js` 而不是 `.json`**：nginx 的 immutable 白名单是
`-[a-zA-Z0-9_-]{8,}\.(js|css|woff2?|mp4|webm|jpe?g|png|webp)`（`sites-enabled/blog` 两个
443 块各一份）——**`json` 不在里面**，产物叫 `.json` 会掉进下面那条 `\.(js|css|json)$` 的
`no-store`，每次刷新重下 36KB。叫 `.js` 则命中 immutable，且文件名的 hash 段天然 cache-bust。

`manifest.json` 故意留在 no-store：前端靠它发现"当前该加载哪个 hash"，所以**重出图不必改
前端代码、不必 bump 版本号**（`?v=` 那套是给文件名不变的资源用的，这里文件名自带内容标识）。

文件名正则 `^graph-[A-Za-z0-9_-]{8,}\.js$` 在 `loader.ts:FILE_RE` 里校验——不是形式主义，
**文件名不合规就会静默掉出 immutable 缓存**。

字段名故意单字母（`w/x/y/z/n/a/a2`、边是 `[a,b,sim]`）：333 点 + 569 边，短键名让产物从
49KB 降到 36KB。`types.ts` 是这份契约的注释版。

> ⚠️ **`v` 里含构建时间戳**：`build_id = sha1(JSON(不含 v))[:12]`，而 payload 里有 `built`
> 字段（本地钟面时间），所以**重跑一次就会得到新文件名，哪怕内容一字未改**。不是幂等内容
> 哈希，只是"一次构建一个不可变 URL"。想知道内容有没有变，比 `graph-*.js` 的字节数或 diff
> 前 200 字节（`built` 在第 79 字节附近）。

脚本本地只保留最近 2 代 `graph-*.js`（按 mtime），留一代给 manifest 手动回滚。
**但仓库里只跟一代**——回滚靠 git 历史，不靠多留一个 37KB 的死文件。
所以出图后提交时**显式 `git add` 当前那一代 + manifest**（别 `git add frontend/public/graph/`，
那会把上一代也带进去）。

### 1.2 agent：`saudade-blog-agent/data/word_graph/`（不进 git，可重生成）

| 文件 | 内容 |
|---|---|
| `index.json` | `{build_id, model, dim, count, built, strip_top, words[]}`（3145B） |
| `vectors.f32` | L2 归一化后的节点向量，`count × dim` 小端 float32 行主序（1.37MB） |
| `mean.f32` | 语料均值（dim 个 float） |
| `dirs.f32` | 被剔除的主方向（`strip_top × dim`）——**`strip_top=0` 时本来就是 0 字节** |

**生产 venv 里没有 numpy**（当初刻意没装）。所以 `rag/wordgraph.py` 用 stdlib `array('f')`
读裸 float32，点积走 `map(operator.mul, row, q)`（C 循环）：333×1024 实测 17ms，不值得为它
给生产环境加一个编译依赖。`_read_f32()` 容忍 0 字节与截断文件。

### 1.3 查询侧变换必须与建图侧逐字节一致

`rag/wordgraph.py::transform_query` 与建图脚本 `project_3d` 里的变换是同一套：
**`q/‖q‖` → 减 `mean` → 减去每个被剥离主方向上的投影 → 再归一化** → 与已归一化节点行做点积。

不一致的后果很隐蔽：图谱按"处理后"的相似度连边，查询却按"原始"相似度找人，会出现
**搜 X 结果飞到一个视觉上离 X 很远的角落**——不报错，只是感觉不对。改一处必须改两处。

---

## 2. 建图管线

`saudade-blog-agent/scripts/build_word_graph.py`（dev 工具，不进生产 venv）

运行环境：**系统 python3.12 + `--target` 装到 `/home/ubuntu/graph-lib` 的 numpy/jieba**
（`numpy 2.5.2` 来自系统 python）。完整命令：

```bash
cd /home/ubuntu/memory_blog_rust/saudade-blog-agent
PYTHONPATH=/home/ubuntu/graph-lib python3 scripts/build_word_graph.py            # 出图
PYTHONPATH=/home/ubuntu/graph-lib python3 scripts/build_word_graph.py --dry-run  # 只看词表，不调 embedding
```

| 步 | 做什么 | 关键参数 |
|---|---|---|
| ① | 拉语料：列表 → 逐篇详情（正文走 `/notes/:id`，列表接口正文为空） | `--api-base` |
| ② | 过滤：`EXCLUDE_IDS={9,10,11}`（测试文）+ 正文 <400 字 + 标题 `^(测试\|test\|hello\|aaa\|untitled)` | `--exclude-ids --min-chars` |
| ③ | 清洗：去 front-matter/HTML 注释/图片/裸 URL，`[text](url)` 留 text，**保留代码围栏内容**（rust/axum/tokio 正是好词） | |
| ④ | 抽词 `jieba.posseg`：`POS_DROP` 词性闸 + ASCII 3~16 字 + 中文 ≥2 字 + 停用词 + 词黑名单 + 词形折叠（log/logs 并成一个点） | `scripts/graph_blocklist.txt` |
| ⑤ | 选词：每篇按 `imp=tf·idf` 取前 `clamp(round(0.9·√chars)+8, 14, 70)` 个，全局再按重要度裁到 `--max-nodes` | `--max-nodes`（默认 400） |
| ⑥ | 嵌入**裸词**（不拼上下文，与查询侧同构）：`text-embedding-v4` / 1024 维 / 批 10 / md5 缓存 | `--refresh` 强制重嵌 |
| ⑦ | 降维：PCA（去均值 → `U[:,:3]·S[:3]^α` → 逐轴 `sign·\|z\|^γ` → 98 分位归一 → clip ±1.6） | `--alpha 0.3 --gamma 1.0 --clip 1.6` |
| ⑧ | 布局：**语义弹簧松弛**（见 §3） | `--layout --layout-iters 400` |
| ⑨ | 连边：处理空间 kNN，`--knn-k 6`、`cos ≥ --knn-tau 0.30`；补最近邻救孤立点；每点 ≤3 条 | |
| ⑩ | 词→文章归属 `s(w,a)=tf·idf·(标题2.2/标签1.6/摘要1.3)`，取 max 为 `a`、次选 `a2` | |

**每次运行都写两份报告**（人工过目用，不看产物也该看这个）：

- `eval/report/wordgraph/<ts>_vocab.txt` — 每篇文章选中的词 + 全局 top120
- `eval/report/wordgraph/<ts>_build.json` — 全部参数、全部质量指标、top60、每篇词表

选词是纯 CPU 的，**改词表/黑名单重跑零 API 成本**（只有新词才需要 embedding，md5 缓存命中）。

---

## 3. 布局取舍：为什么不是纯 PCA（实测数据）

纯 PCA 是"诚实的投影"（位置 = 向量空间的线性投影），但它有个致命问题：
**线长是位置的函数，而位置上相邻的两点未必语义相近**——3 个主成分只解释 17.4% 方差，
剩下的信息被压掉了。于是"线长短"与"语义远近"几乎无关，而用户看图时是靠线长读关系的。

现行方案：**PCA 出初值 → 在三维里做语义弹簧松弛**（吸引项 = 边上的语义相似度，
弱锚定项 = 别漂离 PCA 初值）。得到的是一张"语义地图"而不是严格投影：
**位置是拓扑正确的，但不是向量的线性像**。这是有意的取舍，也是 `--layout pca` 保留着的
原因——想验证投影时说一声就能回到纯线性。

同一份词表、同一批向量，两种布局实测（`--layout` 切换，20260915）：

| 指标 | 语义弹簧（现行） | 纯 PCA | 怎么读 |
|---|---|---|---|
| 近邻保真度（视图 10-NN vs 处理空间 10-NN） | **0.287** | 0.192 | 随机基线 0.030。视图里"挨着的"有多少真的是语义近邻 |
| 同上，对照原始 embedding | 0.266 | 0.176 | 兜底口径，必然更低 |
| **线长-相似度秩相关** | **−0.504** | −0.068 | **负值才对**（越相似线越短）。纯 PCA 基本不携带语义 |
| 边数 | 569 | 566（长线剔除 3） | |
| 产物 | 37174 B | 37085 B | |
| 质量门 | ✓ | ✓（rho 门只对 semantic 生效） | |

质量门（`--force` 可越过，**不建议**：产物直接上线给访客看）：

- 近邻保真度 ≥ 0.15
- 语义布局下线长-相似度秩相关 ≤ −0.40
- 节点数 150~600

> ⚠️ **秩相关的符号是踩过的坑**：这里算的是 `spearman(线长, 相似度)`，所以"越相似线越短"
> ⇒ **负值才正确**。曾经写成 `spearman(-线长, 相似度)` 再按"应为负"读，把结论整个读反。

产物自带 `stats`（`var3_sum/fidelity/len_sim_rho/...`），前端角落与 `types.ts` 都能读到，
质量指标不需要另找地方对账。

---

## 4. 查询链路

```
浏览器输入框（回车触发）
  → POST /api/public/graph/query      裸 fetch + AbortController 7s
  → src/routes/graph.rs               要求登录；结果缓存 10min/500 条；硬超时 6s
  → 127.0.0.1:8010/graph/query        rag/wordgraph.py：embedding 5s + 纯 Python 点积
  → {ok, words:[{w,s}], build_id, ms}
```

### 4.1 三层超时：7s > 6s > 5s

**每一层必须比它内层更长**，否则外层先掐断，内层已经判定好的 `ok:false` 原因就传不回来
（外层的 `agent_unavailable` 会盖掉内层更精确的 `embed_failed`/`dim_mismatch`）。

| 层 | 超时 | 位置 |
|---|---|---|
| 前端 AbortController | 7000ms | `wordgraph/locate.ts:TIMEOUT_MS` |
| Rust → agent | 6s | `routes/graph.rs:AGENT_TIMEOUT` |
| agent → embedding 端点 | 5.0s | `rag/wordgraph.py:EMBED_TIMEOUT` |

稳态 ~200ms（实测 238ms / 276ms），所以这三层都只是兜底。
**改任何一层都要一起看这三个数**——三个文件里都写了这句注释。

### 4.2 只对登录用户开放

查询每次花一次 embedding 调用，匿名可刷就是费用敞口，所以：

- Rust handler 内校验 JWT（`current_uid`，与 `talks.rs` 同款）→ 无 token 返回 **401**
  `{ok:false,reason:"login_required"}`。
- **路由挂在 `public_routes` 而不是 `protected_routes`**：后者是后台管理链路（`auth_guard`
  要求全 admin），而这里任何登录用户都该能用。
- 前端未登录时输入框与按钮都是 `disabled`，占位提示「登录后可用向量检索」。
  **拖动/缩放/双击跳文章不受影响**——未登录访客照常看图和交互，只是不能检索。
- 长度闸 64 字（Rust 与 agent 各一道），`graph_blocklist` 之外还挡掉长查询：
  "定位到最近的词"对一条 500 字的输入没有意义，只会把 embedding 费用拉高。

### 4.3 失败一律降级，绝不报错

`ok:false` 的路径全部返回 **HTTP 200**（除未登录的 401）：这是可降级端点，
返回 5xx 只会让浏览器控制台多一堆红字，降级结果一模一样。

前端的 A/B 两条路：

- **A（默认）真 embedding**：登录了就发请求。
- **B 本地关键词匹配**：图谱自带的 333 词就是现成词典——ASCII 整词匹配（含前缀容错），
  中文从左到右最长匹配（4→3→2 字）；零命中退回字符 bigram Jaccard 取 top8，
  **保证任何输入都有落点**（哪怕落点是错的，也好过按了回车什么都没发生）。

两条路产出同一种 `LocateHit[]`，下游相机运动与高亮逻辑完全一致，
**降级对 UI 不可见**——只有"已登录却仍走了 B"时才浮一行「检索服务暂时不可用，已用本地匹配」
（这是服务侧真的有问题，不该悄悄咽掉）。

`query_words()` **绝不抛异常**；`_embed_one` 显式用 `settings.qwen_api_key/qwen_base_url`，
**不跟 `active_llm_*`**——active provider 可能是 deepseek（没有 embeddings 端点），
跟着 active 走会在切 provider 时哑掉。

### 4.4 embedding 预热（否则部署后第一个查询必然降级）

首次 embedding 调用要 DNS + TLS 建连，**实测 3014ms**；稳态只有 100~300ms。
不预热的话，agent 每次重启后的第一个查询都会慢到被上游超时掐掉、静默退化成本地匹配——
用户看到的就是"刚部署完那会儿定位不准"（而且只有那一个查询，特别难复现）。

`rag/wordgraph.py::warm()` 在 FastAPI `lifespan` 里用一个守护线程调一次。
实测重启后两个 uvicorn worker 分别在 944ms / 726ms 完成预热。

### 4.5 产物热替换：重出图不必重启 agent

`_load()` 比对 `index.json` 的 `build_id`，变了就整份换掉内存里的词表与向量。
实测：重新出图后直接发一个查询，日志里出现
`载入产物 b30f32cce678：333 词 × 1024 维`，同一次请求就返回了新结果。

---

## 5. 重建流程

```bash
cd /home/ubuntu/memory_blog_rust/saudade-blog-agent

# 1) 只改词表/黑名单的话，先干跑看一眼（零 API 成本）
PYTHONPATH=/home/ubuntu/graph-lib python3 scripts/build_word_graph.py --dry-run
#    看 eval/report/wordgraph/<ts>_vocab.txt，确认没有误伤

# 2) 正式出图（写了两份产物：前端 public/graph + agent data/word_graph）
PYTHONPATH=/home/ubuntu/graph-lib python3 scripts/build_word_graph.py

# 3) 前端与 agent 的产物都在 git 里（agent data/word_graph 被 gitignore，但它不被代码引用，
#    只被同一台机器上的 agent 进程读——所以出图后**不需要**任何同步动作）
#    前端产物要提交：git add frontend/public/graph/

# 4) agent 不需要重启（热替换，见 §4.5）；前端产物随 CI 部署上线
```

新增文章后**必须重跑**（否则新文章的词不在图里，双击也跳不到它）。
`--refresh` 会强制重新嵌入所有词（正常情况不需要，md5 缓存让重跑几乎零 API 成本）。

---

## 6. 验证

本机不能 `vite build`（3.7GB 内存会 OOM），所以前端验证走
**esbuild 单文件打包 + CDP 数值断言**：

```bash
cd frontend
node tests/wordgraph-engine.test.mjs      # 34 条：投影/命中/取景的纯数学
node tests/wordgraph-artifact.test.mjs    # 30 条：产物契约 + 质量门 + nginx 命名
python3 tests/wordgraph_render.py         # 20 条：playwright 真实渲染（不起服务）
```

`wordgraph_render.py` 用 `page.route` 把整个源从磁盘喂回去（**必须 `goto` 一个真 URL，
不能 `set_content`**：`about:blank` 没有 base URL，相对 fetch 会直接 "Failed to parse URL"），
所以真实的 `loader.ts` 也一并被验了：manifest 校验 → 动态 import → `export default`。

其中两条断言是别处看不出问题、只有渲染测试能抓的：

- **空闲 3 秒 rAF 计数增量为 0**（性能硬门槛）。首页是全站最重的页面，
  这个组件拉着一个 333 点/569 边的画布，**绝不能有常驻渲染循环**。
  命中辉光因此是有上限的（`PULSE_MS = 1800`）——无限脉冲等于常驻循环。
  断言分两处：首屏后空闲 3s、以及定位动画 + 辉光都结束后再验一次。
- **"画面变了没有"用逐像素差异，不用质心位移**。点云近似一个球，转它的时候亮的像素在
  球面上换了一批，**质心几乎不动**（实测拖动 120px 只移动 4.9px < 5px 的阈值）。
  差异比例才是忠实的度量。

定位断言用 `'线程协程并发'` 而不是 `'异步编程'`：后者只命中「异步」一个词，
"簇摆到画面中心"对单点是**恒真**的——用它跑过一版，断言是绿的但等于没测。
现在会先断言命中 ≥3 个且世界空间里散开度 > 0.15，两处取景系数写错都会红。

`cameraFor` 的取景距离有个推导，别把系数往小调：视锥半高 = `dist·tanθ`，
包围球最外圈的点在近侧只有 `dist−radius` 深，透视放大后偏出 `f·radius/(dist−radius)`。
要求它不超过半高的 0.9 倍 ⇒ **`dist ≥ radius·(1 + 1/(0.9·tanθ)) ≈ 3.38·radius`**。
调到"刚好包住球心"的话最外圈的点会掉出画面，而"能看见全部命中词"正是这个功能的意义。

---

## 7. 性能与已知限制

### 做到了

- **静止即零 rAF**：整个引擎只有 `invalidate()` 一个地方排帧，`raf !== 0` 就是"已经有一帧
  在排"，没有常驻循环。由渲染测试断言。
- 出视野（IntersectionObserver）/ 切后台（visibilitychange）冻结。
- DPR 上限 1.5（3x 屏按原样渲染等于白烧 4 倍填充率，肉眼分不出）。
- 边按相似度分 4 档，每档一次 `stroke`：569 条边走 4 次绘制调用，不是 569 次。
- 标签分层（A 层前 22 名常驻 / B 层按深度补到 34 / C 层命中强制显示）+ 贪心 AABB 防重叠，
  `measureText` 有缓存，`document.fonts.ready` 后清缓存重绘。
- 数据懒加载：**只在夜间挂载的那一刻**才去取 manifest + 动态 import 产物，模块级 promise 缓存。
- 帧耗时 EMA 滞回降档（连续偏慢 → DPR 1 + 标签减半），无 WebGL 的机器一开始就降档。
- **⛔ 窗口不用 `backdrop-filter`**：站点为此出过两次事故（`App.sass:10-11`、
  `ContentHome/index.sass:81-82`），合成器逐帧重算模糊。半透明观感靠纯 rgba + 静态
  radial-gradient。
- `prefers-reduced-motion` 下 `flyTo` 直接瞬移，不走动画。

### 限制（写在这里免得后来者猜）

- **词表 50% 是 ASCII 代码标识符**（333 词里 165 个）。这是 tf·idf 排序的自然结果：
  代码标识符多只在单篇文章里反复出现 → idf 高 → 排得靠前。对这个博客并不算错
  （`AsyncClient`/`ESP32`/`EMQX`/`bisect` 确实是指向具体文章的锚点），但**它决定了查询的
  手感**：中文 query 走本地兜底时经常匹配不到东西。
- **常见中文技术词缺失，两种成因（已核实）**：
  - **被词性闸误伤**：`POS_DROP` 里有 `f`/`nr`，于是 **前端(f)、后端(后/f)、索引(nr，
    jieba 把它当人名)** 直接被丢掉。这几个是闸的门槛问题，加白名单可治。
  - **被每篇 70 词配额挤掉**：缓存(v)/部署(n)/渲染(v)/接口(v) 过了闸也过了词性，
    但它们跨篇出现 → idf 低 → 排不过单篇里的代码标识符。要救得调配额或专门提权。
  - 反例（**不是**管线的问题）：性能/算法/主题/向量/检索 在语料里出现 0 次，
    没有就是没有。
- **零命中的中文 query 会"什么都没发生"**：本地兜底在整词/子串都匹配不到时会退到
  bigram Jaccard，而词表以 ASCII 为主 ⇒ 中文 bigram 与它无交集 ⇒ 返回空数组。
  UI 会浮一行「没找到相关的词，换个说法试试」且相机不动（这是设计好的分支），
  但**登录用户走 A 路不受影响**（真 embedding 永远返回 top-8）。
- **位置是语义地图，不是投影的线性像**（§3）。双击读出的是"这个词属于哪篇文章"，
  不要试图用它反推向量坐标。
- 白天不显示窗口；窗口内没有多展品切换 UI（`exhibits.ts` 里加一项就是一个组件，
  但 v1 硬编码取 `[0]`，等真有两件以上再谈切换）。
