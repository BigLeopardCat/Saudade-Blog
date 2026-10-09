# 首页展示柜：文章向量空间知识图谱

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
    ├── remember.ts           上一次浏览的位置/选中态（§11）
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
| `manifest.json` | `{"v":"<id>","file":"graph-<id>.js","bytes":N,"built":"<ISO+08:00>","site":"<归属站点>"}` 131 字节 | no-store |

`manifest.json` 里的 `built` 与产物内那份**同源**（`build_word_graph.py` 写 manifest 时直接取
payload 的 `built`）——展示柜标题栏那个角标读的就是它（§8.9），形状是
「`2026年09月17日 UTC+8 13:20:55`」（数值随产物走），所以**重出图后角标自动跟着走**，
前端不必改一个字。`built` 可选：老 manifest 没有这个字段时
`loadManifest()` 照样返回，`badge` 返回 null、角标不渲染（不会打出 `undefined年`）。

**`site` = 产物的归属站点**（`build_word_graph.py` 写入；后台重建时由页面传**浏览器自己的
origin**，见 §1.1b）。产物里内嵌的是**建图时那些文章**的词与标题，所以别人 clone 这个仓
直接部署，展品会把原作者的文章画到他的首页上。前端拿 `site` 跟本站 origin 比
（`loader.ts::siteMatches`），不是本站就**在取产物之前抛 `SiteMismatchError`**
（`WordGraphExhibit` 显示"尚未为本站点生成"）——第三方看到的是这一句提示，不是别人的语料，
也不是一张加载失败的破卡片。

> ⚠️ **这道闸在运行期，不在构建期**（不能挪回 `vite.config.ts` 的
> `GRAPH_OWNERSHIP` / `__GRAPH_LOCAL__`）。构建期比对的致命处在于：**页面在构建那一刻
> 还不知道自己会被从哪里打开**，判据被烧进 bundle ⇒ "迁移到新机器 → 重新建图 → 构建一次"
> 这条再正常不过的路**永远过不了闸**（构建机上看不到新域名下的新产物）。这正是用户说的
> "别人用不了"的一半；另一半是产物只能靠 `vite build` 才到得了浏览器（§1.1b）。

判定规则（缺 `site` / 产物建在回环地址 ⇒ 认作本站，老产物向后兼容）：

| `manifest.site` | 访客浏览器的 origin | 结果 |
|---|---|---|
| 缺失（老产物） | 任意 | 显示（向后兼容） |
| `http://localhost:3000` 等回环地址 | 任意 | 显示（开发者自己建的图） |
| `https://saudade.site` | `https://saudade.site` | 显示 |
| `https://saudade.site` | `https://example.com` | **不显示**，提示去后台重建 |

**重建过图谱的人自动通过** —— 后台那个页签会把发起重建时的 origin 写进 manifest
（`site` 默认填的就是它），于是产物天然属于他自己。**闸在取产物之前**是有意的：先下载
再判断，等于把另一个站点的文章词表拉进了访客的浏览器（沙箱断言 `HITS["artifact"] == 0`
钉着这一点）。

### 1.1b 两条产物通道 + 后台重建

**两条通道，同一个文件名形状**（`^graph-[A-Za-z0-9_-]{8,}\.js$`，前端
`loader.ts:FILE_RE` 与 Rust `valid_artifact_name` 各一份、必须同源）：

| 通道 | 目录 | 谁来供 | 谁写 |
|---|---|---|---|
| 种子 | `frontend/public/graph/`（committed） | nginx 直服 `dist/graph/` | 人工跑脚本 + 提交 |
| 生产 | `saudade-blog-agent/data/word_graph/web/`（不进 git） | Rust `GET /api/public/graph/{manifest,artifact/:file}` | 后台重建任务 |

⚠️ **后台那份不能写进 `frontend/public/graph/` 或 `dist/`**：nginx 直服 `dist`，而 CI 部署的
dist 差集清理会把服务端写的文件换回仓库里那份（**静默回退成旧图**）。这就是要两条通道的原因。

前端**先问 API、再回落静态**（`loader.ts::loadManifest`，模块级缓存）。顺序刻意反过来：
没重建过的站点多花一次请求，换来的是"重建完刷新即新图"——**重出图不必等一次 CI 部署**。

两条通道的缓存头各归各的：种子那条由 nginx 决定（下面那段白名单）；生产那条由
`src/routes/graph.rs` 决定（`text/javascript; charset=utf-8` + 一年 immutable），
`^~ /api/` 前缀 location 会跳过所有正则 location，所以 `\.(js|css|json)$` 抢不走它。
⚠️ 日后若有人加一条能匹配 `/api/...js` 的正则 location，这里设的头全部失效
（症状：产物被 no-store，或类型变成 `text/html`）。

**没有服务端产物时 manifest 返回 200 + `{}`，不是 404**：首页每次加载都会问一次这个端点，
一个从没重建过的站点（正是"别人 clone 下去直接部署"那一类）会让**每个访客的控制台每次
都多一条红字**，而这是可降级端点。契约是**"`file` 字段缺席"** ⇒ 前端回落静态种子；
真读出错（权限/IO）才 500。

**重建入口**：后台「站点设置 → 向量图谱」页签（`pages/Dashboard/UserControl/GraphRebuild.tsx`）
→ Rust `/api/protected/graph/rebuild{,/status,/cancel}`（以发起人身份现签断言）
→ agent `rag/graph_build.py`（文件锁 + `state.json` + 内存预检 + 自成进程组的子进程）
→ 产物写进上表"生产"那一格。页面 1.5s 轮询状态与日志尾部；成功摘要里的节点/字节/版本
读的是**产物自己写的账**，向量用量拿不到那行日志时说的是"没调 embedding"而不是 0/0
（`--dry-run` 与"全命中缓存"是两件事）。

状态机 `running` → `done` / `failed` / `cancelled`，另有两种要认：**`interrupted`**
（进程组在收尾途中被打断——不猜，如实报成中断），以及 **`precheck` 模式**（只做内存预检、
不真跑建图的另一次任务，与 `rebuild` 共用同一把锁 / 同一个 `state.json` / 同一条轮询路径）。
成功摘要的字段名：`embed_new` / `embed_hit`（本次新嵌 / 命中缓存）、`reload_local` /
`reload_error`（agent 侧热替换成没成）；产物摘要缺字段时会额外带一条 `warn`。

**只算公开文章**由 Rust 保证：脚本走 `/api/public/notes`，而那条 SQL 里就写着
`IsPublic=true AND Status!='draft'`（`src/routes/notes.rs`）。上限是列表接口一页
1000 篇（`page_size` clamp 1..1000）——正好 1000 就可能是被截断的，页面会就此警告。

**为什么用 `.js` 而不是 `.json`**：nginx 的 immutable 白名单是
`-[a-zA-Z0-9_-]{8,}\.(js|css|woff2?|mp4|webm|jpe?g|png|webp)`（`sites-enabled/blog` 两个
443 块各一份）——**`json` 不在里面**，产物叫 `.json` 会掉进下面那条 `\.(js|css|json)$` 的
`no-store`，每次刷新重下 45KB。叫 `.js` 则命中 immutable，且文件名的 hash 段天然 cache-bust。

`manifest.json` 故意留在 no-store：前端靠它发现"当前该加载哪个 hash"，所以**重出图不必改
前端代码、不必 bump 版本号**（`?v=` 那套是给文件名不变的资源用的，这里文件名自带内容标识）。

文件名正则 `^graph-[A-Za-z0-9_-]{8,}\.js$` 在 `loader.ts:FILE_RE` 里校验——不是形式主义，
**文件名不合规就会静默掉出 immutable 缓存**。

字段名故意单字母（`w/x/y/z/n/a/a2`、边是 `[a,b,sim]`）：单字母键名是把体积压下来的手段。
**两个数字别混着引**——仓库里 committed 的**种子**与线上正在供的**生产**那份是两代产物
（撰写时：种子 `1d1323374540`，400 点 + 778 边 + 46276 B；生产 `4b43643ac308`，
400 点 + 776 边 + 50735 B。边数与体积随语料变，加了两列热度字段 `h`/`hv` 也会变大）。
`types.ts` 是这份契约的注释版。

> ⚠️ **`n` 与 `h` 的取值分布差一个量级**（同一对产物实测）：`n`（tf·idf）min 0.006 /
> mean 0.060 / max 1.000，`h`（热度）min 0.093 / mean 0.583 / max 1.000。这不是 bug——
> 前者是"这个词在一批长文档里多有代表性"（绝大多数词都很平庸），后者是
> `0.75·heat[主] + 0.25·heat[次]` 归一化后的文章热度（文章之间热度本来就不悬殊）。
> 后果是**点的大小差别被压小了**：走 `h` 之后括号项只在 3.18~4.80px 之间
> （走 `n` 是 1.94~4.80px，见 §8.11）。

节点上另有两个后加的字段（**同一代的老产物没有它们，前端要能照常画**）：

| 字段 | 在哪 | 含义 |
|---|---|---|
| `h` | `nodes[]` | 节点热度 = `0.75·heat[主文章] + 0.25·heat[次文章]`，归一化到 0..1 |
| `hv` | `articles[]` | 该篇自己的热度（0..1），读数卡显示的就是它 |

`heat = log1p(views) + 3·log1p(likes) + 3·log1p(favorites) + 4·log1p(comments)`
（权重是建图脚本里 `HEAT_W` 那**一块常量**，要调只调那里；每个读数先 log1p 再乘，
免得一篇爆款把其余文章全压成一个点）。

- **取不到读数不是错误**：那篇照常进图、热度记 0，id 进 `stats.heat_missing` 单列
  ——"接口没给"与"读数真的是 0"是两件事（同 `note_stats` 的 `liked` 口径）。
  四个读数必须齐全，缺一个就整篇算"取不到"，**不拿 0 顶替**。
- **`n`（tf·idf 重要度）留在产物里，但不再决定点的大小**：它只喂 `locate.ts` 的
  局部关键词回退做检索相关性。**热度不许影响搜索排序**——否则热门文章的词会垄断一切查询。
- 前端取 `heatOf(n) = n.h ?? n.n`（老产物自动退回重要度），再走一个地板
  `h_eff = 0.15 + 0.85·h`：新站所有读数都是 0 时图还是一样的图，不会塌成一群同样大的点。

> ⚠️ **`v` 里含构建时间戳**：`build_id = sha1(JSON(不含 v))[:12]`，而 payload 里有 `built`
> 字段（本地钟面时间），所以**重跑一次就会得到新文件名，哪怕内容一字未改**。不是幂等内容
> 哈希，只是"一次构建一个不可变 URL"。想知道内容有没有变，比 `graph-*.js` 的字节数或 diff
> 前 200 字节（`built` 在第 55 字节附近——`export default {"model":…,` 那段前缀之后）。

脚本本地只保留最近 2 代 `graph-*.js`（按 mtime），留一代给 manifest 手动回滚。
**但仓库里只跟一代**——回滚靠 git 历史，不靠多留一个 37KB 的死文件。
所以出图后提交时**显式 `git add` 当前那一代 + manifest**（别 `git add frontend/public/graph/`，
那会把上一代也带进去）。

### 1.2 agent：`saudade-blog-agent/data/word_graph/`（不进 git，可重生成）

| 文件 | 内容 |
|---|---|
| `index.json` | `{build_id, model, dim, count, built, strip_top, words[], base_url}`（400 词，随词数变；磁盘上那份约 3.7KB）。**`model` / `base_url` 记的是这份产物建在哪片 embedding 空间上**，查询侧拿它当场对一次——不符就 `space_mismatch` 明着降级，见下。`base_url` 是后加的字段，**老产物没有它**（那一格不判） |
| `vectors.f32` | L2 归一化后的节点向量，`count × dim` 小端 float32 行主序（1638400B = 400×1024×4） |
| `mean.f32` | 语料均值（dim 个 float） |
| `dirs.f32` | 被剔除的主方向（`strip_top × dim`）；当前 `strip_top=1` ⇒ **4096 B**（1×1024）。`strip_top=0` 时它是 0 字节——查询侧本来就按 `index.json` 的 `strip_top` 读，两种都能跑 |

#### embedding 空间：建图与查询共用一处配置

建图与查询**共用 `rag/embed_space.py` 一条解析规则**（**只用标准库**：建图跑在
`uv run --no-project` 的隔离环境里，那里没有 pydantic，也没有 agent 的其他模块）：

- 配了 `EMBEDDING_MODEL` + `EMBEDDING_API_KEY`（非空、非占位 `your-api-key-here`）⇒ **用它**
  （`EMBEDDING_BASE_URL` 留空 = OpenAI SDK 默认端点）；
- 否则回落 `QWEN_API_KEY`/`QWEN_BASE_URL` + `text-embedding-v4`/1024/批 10
  ⇒ **只配 `QWEN_*` 的老部署行为逐字不变**；
- 两处都空 ⇒ 建图当场停下，**并说清缺的是哪一格**（`rag/embed_space.py::missing_config`
  一句话，建图侧 `sys.exit`、查询侧 WARNING 共用它——同一件事在终端与日志里必须说成一件）。

判据与 `Settings.embedding_configured` 同一口径（有一条测试锁着不许漂）。
`EMBEDDING_DIM=0` 的语义与 RAG 那侧一致：**不向 API 传 `dimensions`**，以返回长度为准。

**换空间之后必须重建一次图谱**：产物记着自己那片空间（`model` + `base_url`），
查询侧 `_load()` 会当场对一次，不符则

* 记**一条** WARNING（每个 `build_id` 只记一次，不刷日志），
* `query_words` 返回 `{"ok": false, "reason": "space_mismatch"}`——**在花掉那次 embedding
  调用之前**就返回（零 API 成本），

Rust → 前端照既有降级链路退回本地关键词匹配。老产物没有 `base_url` 这一格 ⇒ 那一格不判
（只在这一格上 fail-open）。**静默混两代向量**是这里最坏的失效形态：图谱按 A 模型的空间连边、
查询却拿 B 模型的向量找人，症状正是 §1.3 那句"搜 X 结果飞到一个视觉上离 X 很远的角落"，
而且不报错。

建图侧的 `eval/cache/word_graph_vectors.json`（键 = `md5(词)`，4.8MB/453 条，已 gitignore）
**按空间记账**：文件头记下这片空间的 `{model, base_url, dim}`，对不上就**整份作废重嵌**，
绝不半读（半读 = 两代向量混进同一张图）；旧格式（没有签名）只在"就是那条老路"时认
——旧文件的唯一可能出处是 `text-embedding-v4` + `QWEN_BASE_URL`。

**生产 venv 里没有 numpy**（刻意不加）。所以 `rag/wordgraph.py` 用 stdlib `array('f')`
读裸 float32，点积走 `map(operator.mul, row, q)`（C 循环）：400×1024 实测 **~15ms**
（同口径复测落在 15~17ms，机器负载会左右这个数），不值得为它给生产环境加一个编译依赖。
`_read_f32()` 容忍 0 字节与截断文件。

### 1.3 查询侧变换必须与建图侧逐字节一致

`rag/wordgraph.py::transform_query` 与建图脚本 `project_3d` 里的变换是同一套：
**`q/‖q‖` → 减 `mean` → 减去每个被剥离主方向上的投影 → 再归一化** → 与已归一化节点行做点积。

不一致的后果很隐蔽：图谱按"处理后"的相似度连边，查询却按"原始"相似度找人，会出现
**搜 X 结果飞到一个视觉上离 X 很远的角落**——不报错，只是感觉不对。改一处必须改两处。

---

## 2. 建图管线

`saudade-blog-agent/scripts/build_word_graph.py`（dev 工具，不进生产 venv）

运行环境：**`uv run --no-project` 的临时环境**，依赖清单在
`scripts/requirements-graph.txt`（numpy/jieba/umap/numba/scipy）。**不要再退回
"`--target` 装到仓库外独立目录 + `PYTHONPATH=$GRAPH_LIB`"那条路**——它要求每台机器
先手工铺一遍依赖。**numpy 仍然不进生产 venv**（§1.2）。

```bash
cd saudade-blog-agent
# ① 推荐路径：后台「站点设置 → 向量图谱」点一下（见 §1.1b）。它就是用下面这行跑的，
#    依赖在临时环境里现装（umap/numba/scipy 刻意不进生产 venv）。
uv run --no-project --python 3.12 --with-requirements scripts/requirements-graph.txt \
    python3 scripts/build_word_graph.py --out-web data/word_graph/web --out-agent data/word_graph

# ② 手动只跑词表（不调 embedding、不写产物）——纯 CPU，零 API 成本
uv run --no-project --python 3.12 --with-requirements scripts/requirements-graph.txt \
    python3 scripts/build_word_graph.py --dry-run
```

⚠️ **建图还需要一份可用的 embedding 配置**（完整重建要；`--dry-run` 不要，它不调 embedding）：
`EMBEDDING_MODEL`+`EMBEDDING_API_KEY` 配了就用它，没配则回落
`QWEN_API_KEY`/`QWEN_BASE_URL` + `text-embedding-v4`（见 §1.2）。**两处都空会当场停下、
说清缺的是哪一格**（症状："我明明配了向量检索的 key，后台重建却报缺配置"）。
这几项**写在 systemd 单元的环境里也照样认**（进程环境优先于 `.env`，与 pydantic-settings
的优先级一致）。

| 步 | 做什么 | 关键参数 |
|---|---|---|
| ① | 拉语料：列表 → 逐篇详情（正文走 `/notes/:id`，列表接口正文为空）。**列表接口一页上限 1000 篇**，正好 1000 就可能是被截断的（后台页会就此警告） | `--api-base` |
| ② | 过滤：`EXCLUDE_IDS={9,10,11}`（测试文）+ 正文 <400 字 + 标题 `^(测试\|test\|hello\|aaa\|untitled)` | `--exclude-ids --min-chars` |
| ②b | **热度**：逐篇读 `GET /notes/:id/stats` → `heat`（`HEAT_W` 权重块，见 §1）→ 归一到 0..1，写进 `nodes[].h` / `articles[].hv`（**点的大小就由它决定**）。取不到读数的文章照常进图、记 0，id 单列进 `stats.heat_missing` | |
| ③ | 清洗：去 front-matter/HTML 注释/图片/裸 URL，`[text](url)` 留 text，**保留代码围栏内容**（rust/axum/tokio 正是好词） | |
| ④ | 抽词 `jieba.posseg`：`POS_DROP` 词性闸 + ASCII 3~16 字 + 中文 ≥2 字 + 停用词 + 词黑名单 + 词形折叠（log/logs 并成一个点） | `scripts/graph_blocklist.txt`、`scripts/graph_userdict.txt`（§2.1） |
| ⑤ | 选词：每篇按 `imp=tf·idf` 取前 `clamp(round(0.9·√chars)+8, 14, 70)` 个，全局再按重要度裁到 `--max-nodes`，最后把允许清单里选中的词补回 | `--max-nodes`（默认 400）、`scripts/graph_allow.txt`（§2.1） |
| ⑥ | 嵌入**裸词**（不拼上下文，与查询侧同构）：模型/端点/维度/批量**由解析出的 embedding 空间决定**（配了 `EMBEDDING_*` 用它，否则回落 `QWEN_*` + `text-embedding-v4`/1024/批 10）；缓存键 = `md5(词)`，**缓存按空间记账**（换空间整份作废重嵌，见 §1.2） | `--refresh` 强制重嵌 |
| ⑦ | 处理空间变换：去均值 → **去主方向（`strip_top=1`，剥掉"语言轴"，见 §3.4）** → 软白化 `U[:,:3]·S[:3]^α` → 尾部压缩 `sign·\|z\|^γ` —— **连边/指标/查询都用这套语义**，三维坐标不再由它出 | `--strip-top 1 --alpha 0.3 --gamma 1.0 --clip 1.6` |
| ⑧ | 布局：**UMAP 三维**（见 §3） | `--layout umap --umap-neighbors 15 --umap-min-dist 0.2` |
| ⑨ | 连边：处理空间 kNN，`--knn-k 6`、`cos ≥ --knn-tau 0.20`（τ 跟 `strip_top` 一起调，理由见 §3 第 4 条）；补最近邻救孤立点；每条边只要**任一端点**把它排进自己的前三就保留 | |
| ⑩ | 词→文章归属 `s(w,a)=tf·idf·(标题2.2/标签1.6/摘要1.3)`，取 max 为 `a`、次选 `a2` | |

> ⚠️ **"每点最多 3 条边"是句会读错的话**。脚本里那个 `[:3]` 是**每个点各自对自己那一列边**
> 取前三（`build_word_graph.py` 的 `build_edges` 里那个 `sorted(lst, reverse=True)[:3]`），
> 然后取并集——一条边落在谁的名单里就从谁那儿进图，
> **所以一个点的度数并不受 3 约束**：只要它的邻居们都愿意把它排进前三，它可以连很多条。
> 实测（400 点、两份产物）：**度数 max 9 / 均值 3.88~3.89 / 219 个点度数 >3**（生产那份），
> 分布是 `{1:13, 2:9, 3:159, 4:123, 5:54, 6:21, 7:14, 8:5, 9:2}`；种子那份 778 条边、
> 220 个点度数 >3，分布几乎一样。要引用"边有多密"请引这组数，别引 `[:3]` 这个参数。

**每次运行都写两份报告**（人工过目用，不看产物也该看这个）：

- `eval/report/wordgraph/<ts>_vocab.txt` — 每篇文章选中的词 + 全局 top120
- `eval/report/wordgraph/<ts>_build.json` — 全部参数、全部质量指标、top60、每篇词表

选词是纯 CPU 的，**改词表/黑名单重跑零 API 成本**（只有新词才需要 embedding，md5 缓存命中）。

### 2.1 词表三层：黑名单 / 用户词典 / 允许清单

成因为两处，修法也分两处——**别把两件事混成一件**：

- **切分词性错（治不了配额）** → `scripts/graph_userdict.txt`（jieba 用户词典，`load_userdict`）。
  实测：`前端` → 词性 `f`（方位词，被 `POS_DROP` 丢）、`后端` → 被切成 `后/f`+`端/v`、
  `本地` → `r`（代词，被丢）、`索引` → `nr`（jieba 当人名，被丢）。词典里写 `前端 200 n`
  把词性钉死成名词。**先加载再切词**——`load_userdict` 必须排在第一个 `pseg.cut` 之前，
  否则那一遍切词已经用了旧词典，改了等于没改。
- **词性对、配额挤掉** → `scripts/graph_allow.txt`（受控允许清单，≤12 词）。
  `缓存`/`部署`/`编译`/`客户端`/`数据库`/`初始化`/`note` 都过了词性闸，但跨篇出现 → idf 低 →
  排不过单篇里的代码标识符。允许清单在全局裁剪**之后**把这些词补回（`keep_set` 取并集），
  所以它们不占别人的配额。

**纪律：允许清单只收"语料里真有、且被配额挤掉"的词**。语料里 0 次出现的（`索引`/`向量`/`图谱`/
`检索`/`框架`，逐词实测 0 次）**绝不塞**——那是凭空造节点，不是修 bug；`接口`(2 次)/`容器`(1 次)/
`调试`(1 次) 同理（进图就是孤点）。`POS_DROP` 本体不动：那不是漏词，是闸的门槛。

加 userdict 会让 tf 分布位移，`初始化` 与 `note` 会因此在配额边界掉出——它们是被这份
允许清单**回补**的，不是另外加的词。**词表大小随语料与选词规则变**（撰写时 400 词），
别把任何历史数字当成现值。

运行时会打一行 `（黑名单 N 词 / 允许清单 N 词 / 用户词典 N 词）`，对齐就说明三份都载入了。

---

## 3. 布局取舍：为什么最终是 UMAP

**现行布局：UMAP 三维**（McInnes 2018），`--layout umap --umap-neighbors 15
--umap-min-dist 0.2`。判据是 **10-NN 近邻保真度**（点一个词、它周围的词是不是真的相关），
不是"线看起来好不好"。

同一份语料、同一批 embedding、同一条边集，只换布局（`scripts/layout_ab.py` 可复现）：

| 布局 | 近邻保真度 10-NN |
|---|---|
| **UMAP-3D（现行，`strip_top=1`）** | **0.446** |
| PCA-3D + 语义弹簧（上一版） | 0.255 |
| UMAP-3D（`strip_top=0`） | 0.426 |
| UMAP-3D（n_neighbors=30） | 0.406 |
| UMAP + 弹簧（会吃掉大部分收益） | 0.250~0.275 |
| Isomap（kNN k=10/15/30） | 0.212 / 0.207 / 0.183 |
| SMACOF（只在边集上做应力优化） | **0.027 ≈ 随机** |
| *随机基线* | *0.025* |

三条会一直用到的结论（都写进了代码注释）：

1. **保真度才是访客感受到的东西**，只有 UMAP 显著更好；谱方法一支（PCA / Isomap /
   经典 MDS）全在 0.03~0.26 —— 它们优化全局方差/距离，UMAP 优化局部邻域。
2. **现行布局不叠语义弹簧**：弹簧只用那几百条边（占全部点对 **不到 1%**）去拽 400 个点，
   会覆盖掉 UMAP 学到的结构（0.426 → 0.25~0.28）。
3. **rho（线长-相似度秩相关）不再是质量门**：SMACOF 只优化这些边就能做到
   **rho = −1.000 而保真度塌到随机**——一个只覆盖不到 1% 点对、能被轻易拉满、
   且优化方向与访客感受相反的指标不适合当门。只留一条符号 sanity 防方向写反。

**处理空间里那条"语言轴"要剥掉（`strip_top=1`）**：第一主方向就是「中文 vs ASCII」——
PC1 的组间方差里 **93%** 由它解释（随机方向 8%）。它给同语言虚高、给跨语言压分：
剥掉之后跨语言相似度保留率 **35% → 77%**（设备↔device 0.414→0.731）、三维里那两团从
"肉眼可见的空洞"变成交融、保真度 0.426 → **0.446**，代价是同语言相似度虚高消失
（0.437→0.375）。⚠️ **τ 必须跟着调**（0.30→**0.20**）——不调的话边会掉近三分之一。
⚠️ 这一条与布局耦合：纯 PCA 布局下剥它反而有害，换 UMAP 后最优值才反转（PCA 把这条轴
当最大方差方向优先投射，UMAP 只关心邻域）。**换布局时这两个参数要一起重定。**

**min_dist 的取舍**（UMAP 特有：它只管邻域，不管"铺得开"）：

| min_dist | 保真度 k=5/10/20 | 最近邻距离中位 | 重叠点(<0.02) | 全局点距中位 |
|---|---|---|---|---|
| 0.05 | 0.435/0.433/0.426 | 0.033 | **88**（22% 的点与邻居几乎重合） | 0.618 |
| **0.2（现行）** | 0.423/0.426/0.432 | 0.061 | **8** | 0.777 |
| 0.4 | 0.382/0.412/0.420 | 0.075 | 2 | 0.790 |

取 **0.2**：保真度与 0.05 基本无差，重叠点从 88 降到 8、整体铺得更开。要更开可以
`--umap-min-dist 0.4`，代价约 3% 保真度。

**质量门**（`--force` 可越过，不建议：产物直接上线给访客看）：

- **近邻保真度 ≥ 0.30**（主门；随机 0.025，旧布局 0.255，现行 UMAP **0.446**——即上表
  `strip_top=1` 那一行；`0.426` 是 `strip_top=0` 的对照值，别把这两个数按"现行"和"旧版"引。
  线上产物自己写的 `stats.fidelity` 是 **0.4492**（`4b43643ac308`）：语料每变一次
  这个数就会动，两个都对，只是不同一次构建）
- **多 k 曲线**：k=5/10/20 都 ≥0.25（只有最近一圈被保住时曲线会塌）。
  ⚠️ 这一条**不在建图脚本里**——脚本 `--force` 那道门只查保真度 ≥0.30 与节点数 150~600
  （`build_word_graph.py` 的 `if not args.force` 段），多 k 曲线由前端产物测试
  `frontend/tests/wordgraph-artifact.test.mjs` 断言。
- 节点数 150~600
- 线长-相似度秩相关：**只作为展示参考值打印，不作门**（理由见上）

> ⚠️ **秩相关的符号**：算的是 `spearman(线长, 相似度)`，"越相似线越短" ⇒ **负值才正确**。
> 测试里只留一条符号 sanity 防方向写反（写成正数说明线长方向反了——那比"不带信息"更糟，
> 它在说谎），不再当质量判据。

产物自带 `stats`（`fidelity` / `fidelity_k` / `len_sim_rho` / `layout` / `umap_min_dist` /
`heat_w` / `heat_missing` …），
前端角落与 `types.ts` 都能读到，质量指标不需要另找地方对账。

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
- **长度闸两道，上限不同**：前端截到 64 字（`locate.ts QUERY_MAX`），Rust 也按 64 拦
  （`routes/graph.rs::QUERY_MAX`），agent 侧留一倍余量、`GraphQueryRequest.q` 是 128 字符
  （`server.py`）。所以 agent 那道挡的是"绕过前端直打 8010"的超长输入，不是正常链路。
  `graph_blocklist` 之外还挡掉长查询："定位到最近的词"对一条 500 字的输入没有意义，
  只会把 embedding 费用拉高。

### 4.3 失败一律降级，绝不报错

`ok:false` 的路径全部返回 **HTTP 200**（除未登录的 401）：这是可降级端点，
返回 5xx 只会让浏览器控制台多一堆红字，降级结果一模一样。

Rust 这一层自己也会产出 `reason`（都在 `src/routes/graph.rs`）：`login_required`（无 token 的
401）、`empty_query`、`query_too_long`（超 64 字）、`agent_unavailable`（连不上 / 超时）、
`agent_bad_response`（agent 返回的形状不对）、以及兜底的 `agent_declined`（agent 给了
`ok:false` 却没带 `reason` 时的默认值）。前端对它们一视同仁——只看 `ok` 是不是 true。

前端的 A/B 两条路：

- **A（默认）真 embedding**：登录了就发请求。
- **B 本地关键词匹配**：图谱自带的 400 词就是现成词典——ASCII 整词匹配（含前缀容错），
  中文从左到右最长匹配（上界=**词表里最长的中文词**，从图谱数据现算，不是写死的 4——
  写死 4 会让 5 字词「兼容性问题」连自己当查询都匹配不到）；
  零命中退回字符 bigram Jaccard 取 top8，
  **保证任何输入都有落点**（哪怕落点是错的，也好过按了回车什么都没发生）。

两条路产出同一种 `LocateHit[]`，下游相机运动与高亮逻辑完全一致，
**降级对 UI 不可见**——只有"已登录却仍走了 B"时才浮一行「检索服务暂时不可用，已用本地匹配」
（这是服务侧真的有问题，不该悄悄咽掉）。

> ⚠️ **降级判据只有一条：服务这条路通不通。** 服务端 BM25 弃权闸拆掉之后（见 §10），
> 后端不再有"我判定图里没有这句话"这种结论态（`reason` 只剩 `empty_query` /
> `artifact_missing` / `embed_failed` / `dim_mismatch` / `space_mismatch` 五种故障语义），
> 所以 A 路返回值是**两态**：`LocateHit[]`（路通了）vs `null`（路不通）。
> 闸为什么加、又为什么拆，见 §10。

> ⚠️ **两路的大小写口径必须一致——这是"chips 点了不定位"的真因**（§8.7）。
> agent 索引 `index.json` 的 `words` 是 **ASCII 小写原形**（`build_word_graph.py` 写词时就折了），
> 而前端产物节点的 `w` 是**显示形**（`Python`/`JWT`/`MQTT`…）——同一个词在两份产物里形态不同。
> 最初 `setHighlight` / `cameraFor` / 组件 `findIndex` 三处都是精确匹配，于是 A 路返回的小写词
> **被静默丢弃**：不飞（`cameraFor` 查不到 → 原机位返回）、不亮（hits 为空）、不选中
> （`findIndex` 返 −1）——而 B 路的 `keyOf` 本来就大小写不敏感，所以**"检索服务可用时反而不如
> 降级准"**。现在 `wordKey()` 是唯一来源（`engine.ts` 导出，`locate.ts` 直接 import 它），
> 三处匹配全部走它。**加新匹配点时也用 `wordKey`，别再各写一份 `toLowerCase`。**

`query_words()` **绝不抛异常**；`_embed_one` 用**解析出的 embedding 空间**
（`rag/embed_space.py`：配了 `EMBEDDING_*` 就用它，否则回落 `QWEN_*` + `text-embedding-v4`，
与建图脚本同一条规则，见 §1.2），**不跟 `active_llm_*`**——active provider 可能是
deepseek（没有 embeddings 端点），跟着 active 走会在切 provider 时哑掉。
它的超时 `EMBED_TIMEOUT = 5.0` 是**查询热路径**的值（§4.1 的 7s > 6s > 5s 里最小那个），
**不是**检索那侧的 `EMBEDDING_TIMEOUT=15`——换成后者等于让上游先超时、静默退化成本地匹配。

### 4.4 embedding 预热（否则部署后第一个查询必然降级）

首次 embedding 调用要 DNS + TLS 建连（**秒级**，实测约 3s）；稳态只有 100~300ms。
不预热的话，agent 每次重启后的第一个查询都会慢到被上游超时掐掉、静默退化成本地匹配——
用户看到的就是"刚部署完那会儿定位不准"（而且只有那一个查询，特别难复现）。

`rag/wordgraph.py::warm()` 在 FastAPI `lifespan` 里用一个守护线程调一次。
⚠️ **每个 uvicorn worker 各预热各的**，所以"第一个查询会降级"是按 **worker 数**算的：
当前是 **4 个 worker**（见 [deployment-and-ops.md](deployment-and-ops.md) 的《资源画像与容量》），
即重启后最多有 4 个"第一个查询"要踩这个坑。

### 4.5 产物热替换：重出图不必重启 agent

`_load()` 比对 `index.json` 的 `build_id`，变了就整份换掉内存里的词表与向量，
**同一次请求就返回新结果**（日志里会打一行「载入产物 <build_id>：N 词 × dim 维」）。
⚠️ **每个 worker 各换各的**（§12.2）。

---

## 5. 重建流程

> **日常重建走后台那个页签**（§1.1b）：它写的是 agent 的 `data/word_graph/web/`，
> 不产生任何 git 变更、不必等 CI 部署。下面这段是**改代码的人**（词表/黑名单/布局）
> 才需要的手工流程。

```bash
cd saudade-blog-agent
UV="uv run --no-project --python 3.12 --with-requirements scripts/requirements-graph.txt"

# 1) 只改词表/黑名单/用户词典/允许清单的话，先干跑看一眼（零 API 成本）
$UV python3 scripts/build_word_graph.py --dry-run
#    看 eval/report/wordgraph/<ts>_vocab.txt，确认没有误伤
#    ⚠️ --dry-run 在 embedding 之前就 return，所以**拿不到质量门指标**（只看词表用它）

# 2) 正式出图（不带 --out-web 时写的是仓库里那份种子 frontend/public/graph + agent data/word_graph）
$UV python3 scripts/build_word_graph.py

# 3) 前端与 agent 的产物都在 git 里（agent data/word_graph 被 gitignore，但它不被代码引用，
#    只被同一台机器上的 agent 进程读——所以出图后**不需要**任何同步动作）
#    前端产物要显式 add 当前那一代 + manifest（见 §1.1）：
#      git add frontend/public/graph/graph-<新id>.js frontend/public/graph/manifest.json

# 4) agent 不需要重启（热替换，见 §4.5）；前端产物随 CI 部署上线
#    展示柜角标读 manifest 的 built，重出图后自动跟着走（§1.1）
```

新增文章后**必须重跑**（否则新文章的词不在图里，双击也跳不到它）。
`--refresh` 会强制重新嵌入所有词（正常情况不需要，md5 缓存让重跑几乎零 API 成本）。

> 「线上现在供的是哪一代 / 重出图后哪一层会立刻换 / 出坏了怎么退回去」见 **§12**——
> 那是运维面，出图的人可以只看本节，接手的人应该先看 §12。

---

## 6. 验证

本地不跑 `vite build`（内存开销大、会 OOM），所以前端验证走
**esbuild 单文件打包 + CDP 数值断言**：

```bash
cd frontend
node tests/wordgraph-engine.test.mjs      # 90 条：投影/命中/取景/缩放与穿云手感/大小写/点夹取带的纯逻辑
node tests/wordgraph-artifact.test.mjs    # 39 条：产物契约 + 质量门（保真度≥0.30 与多 k 曲线）+ nginx 命名
                                          #   + 生产产物（存在才验，见下）
node tests/wordgraph-remember.test.mjs    # 33 条：检索态恢复（URL/sessionStorage，§11）
node tests/theme-choice.test.mjs          # 53 条：主题边界（与本文无关，一起跑免得漏）
python3 tests/wordgraph_render.py         # 36 条：playwright 真实渲染（不起服务）
node /tmp/wg-labels.mjs                   # 18 条：引擎渲染语义（标签去重 / 连线基线），见下
node /tmp/wg_sizes.mjs                    # 真产物的点半径/透明度改前后对照表（§8.11）
python3 /tmp/vit_accept_d.py              # 26 条：**线上**验收（标题栏墨迹对齐 / 连线档位 / 飞入点云）
```

> ⚠️ `wordgraph-artifact.test.mjs` 的**最后一段（生产产物）只在生产机上跑得到**：
> 它读 agent 的 `data/word_graph/web/manifest.json`，而那个目录不在版本控制里、agent 又是
> 另一个仓库 ⇒ **CI 上恒跳过**。而且它**不能直接 `import` 那个产物**：Node 按最近的
> `package.json` 决定 `.js` 算不算 ESM，`saudade-blog-agent/` 下没有那个文件（种子那份能直接
> import，只是因为 `frontend/package.json` 写了 `"type": "module"`）——直接 import 会按
> CommonJS 解析、`export default` 当场语法错，**整段崩在断言之前**（**先复制成
> `.mjs` 再 import，既真验了 ESM 可解析性又不被周边 `package.json` 左右）。这类"只在生产机上
> 跑"的断言要当成**手跑项**看待：它有可能是红的而 CI 一直绿。

**布局决策别凭观感**：`scripts/layout_ab.py` 是离线 A/B 夹具（`--variant` 六选一：
`baseline` / `umap` / `umap_spring` / `isomap_knn` / `isomap_edges` / `smacof_edges`，
同语料/同 embedding/
同边集，只换布局，口径与质量门一致）——换布局就得靠它（见 §3）。改布局/调参先跑它。

agent 侧查询链路的纯函数测试（`test_wordgraph_gate.py`）随弃权闸一起删除（见 §10）——
它测的那个部件已经不存在了。
agent 仓的 `eval.yml` 跑的是 `tests/run_all.py`，它按**磁盘枚举** `tests/*.py`
（`_` 开头的辅助模块与 run_all.py 自己除外）——增删套件不用改任何名单。
（这里**不写套件条数**：那个数字由 agent 仓的磁盘决定，本仓抄一份只会静默过期。）
图谱这条链只被其中两个直接覆盖
（`test_graph_build.py` 查重建任务的锁/状态机，`test_word_graph_build.py` 查建图脚本的纯函数），
**端到端查询仍靠** `curl /graph/query` 冒烟 + 线上实点——`rag/wordgraph.py` 每个查询都会往
`logs/agent/agent.log` 打一行 `[wordgraph] q=… → N 词（top=… 0.xxxx）…ms`，
一眼能看出版本给了什么、花了多久。

`/tmp/wg-labels.mjs` 是一次性无头证据脚本（不入库）：它把真 `engine.ts` 打出来，
喂一个**录音机版 2D context**（假 canvas、真渲染调用），直接驱动 `draw()` 断言两件只能这么测的事——
**① 同一帧里任何文字都只画一次**；**② 未选中时连线各档的透明度落在新基线上**。
它做过反证：把 `engine.ts` 里 `labeled.has(i)` 那行短路去掉 / 把边基线 sed 回旧公式，
对应断言立刻红（`Python×2`、`0.112/0.427`）。
`/tmp` 里的东西会被清掉，要复现按这个思路重写即可（esbuild + 假 ctx + 调私有 `draw()`）。

`/tmp/vit_accept_d.py`（线上验收）用的是同一套记录器，只是跑在**线上部署的 bundle** 上：
打桩 `clearRect/arc/fill/stroke` 记录**引擎实际设的 alpha 与半径**，再用合成 `WheelEvent`
把相机滚到底（合成事件不会让鼠标进画布 ⇒ 不触发 hover，否则压暗系数与辉光会污染记录）。
两个坑：**引擎静止即零 rAF**，所以要读"帧号不再变化"时的 `arcs`（`prev` 永远停在第一帧之前的空快照）；
**边的透明度烘在 `strokeStyle` 的 rgba 里、`globalAlpha` 恒为 1**，要解析字符串而不是读 `globalAlpha`。
另外浏览器把 canvas 颜色分量存成 8 位，读回来会看到 `0.113 → 0.114`（29/255）、`0.503 → 0.5`（128/255）
——**这是量化不是算错**，断言按 ±0.005 的带宽留。

`wordgraph_render.py` 用 `page.route` 把整个源从磁盘喂回去（**必须 `goto` 一个真 URL，
不能 `set_content`**：`about:blank` 没有 base URL，相对 fetch 会直接 "Failed to parse URL"），
所以真实的 `loader.ts` 也一并被验了：manifest 校验 → 动态 import → `export default`。

其中两条断言是别处看不出问题、只有渲染测试能抓的：

- **空闲 3 秒 rAF 计数增量为 0**（性能硬门槛）。首页是全站最重的页面，
  这个组件拉着一个 400 点/778 边的画布，**绝不能有常驻渲染循环**。
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
- 边按相似度分 4 档，每档一次 `stroke`：778 条边走 4 次绘制调用，不是 778 次。
- 标签分层（C 层命中/悬停/选中 → N 层选中词的邻居 → Z 层贴脸的 → A 层前 22 名常驻 →
  B 层按深度补到 40，见 §8.4）+ 贪心 AABB 防重叠 + 四向候选位，`measureText` 有缓存，
  `document.fonts.ready` 后清缓存重绘。**每帧一张"已画过标签"的表**做去重（§8.4）。
- 数据懒加载：**只在夜间挂载的那一刻**才去取 manifest + 动态 import 产物，模块级 promise 缓存。
- 帧耗时滞回降档：单帧绘制超 **22ms** 就累加一个计数，**连续 6 帧**偏慢即降到
  「DPR 1 + 标签减半」，此后只降不升（避免在阈值附近来回抖）；无 WebGL 的机器一开始就降档。
- **⛔ 窗口不用 `backdrop-filter`**：站点为此出过两次事故（记录在 `App.sass:14-16` 与
  `ContentHome/index.sass:64`），合成器逐帧重算模糊。半透明观感靠纯 rgba + 静态
  radial-gradient。
- `prefers-reduced-motion` 下 `flyTo` 直接瞬移，不走动画。

### 限制

- **词表约 43% 是 ASCII 代码标识符**（400 词里 173 个）。这是 tf·idf 排序的自然结果：
  代码标识符多只在单篇文章里反复出现 → idf 高 → 排得靠前。对这个博客并不算错
  （`AsyncClient`/`ESP32`/`EMQX`/`bisect` 确实是指向具体文章的锚点），但**它决定了查询的
  手感**：中文 query 走本地兜底时经常匹配不到东西。
- **常见中文技术词缺失，两种成因**：
  - **被词性闸误伤**：`POS_DROP` 里有 `f`/`nr`，于是 **前端(f)、后端(后/f)、索引(nr，
    jieba 把它当人名)** 直接被丢掉。**已修**：`graph_userdict.txt` 钉死 `前端/后端/本地`
    的切分词性（§2.1），这三个词现在是节点。`索引` 是 `nr` 但这个词在语料里出现 0 次，
    进图只会是孤点，**故意不进**。
  - **被每篇 70 词配额挤掉**：缓存(v)/部署(n)/渲染(v)/接口(v) 过了闸也过了词性，
    但它们跨篇出现 → idf 低 → 排不过单篇里的代码标识符。**已修一半**：`缓存/部署/编译/
    客户端/数据库/初始化/note` 走允许清单补回；`渲染`/`接口`/`容器`/`调试` 按纪律不收
    （语料 1~2 次，进图就是孤点）。**配额与全局 400 上限本体没动**。
  - 反例（**不是**管线的问题）：性能/算法/主题/向量/检索/框架 在语料里出现 0 次，
    没有就是没有——**不许为"图谱看起来该有这个词"而把它塞进允许清单**。
- **零命中的中文 query 会"什么都没发生"**：本地兜底在整词/子串都匹配不到时会退到
  bigram Jaccard，而词表以 ASCII 为主 ⇒ 中文 bigram 与它无交集 ⇒ 返回空数组。
  UI 会浮一行「没找到相关的词，换个说法试试」且相机不动（这是设计好的分支），
  但**登录用户走 A 路不受影响**（真 embedding 永远返回 top-8）。
- **位置是语义地图，不是投影的线性像**（§3）。双击读出的是"这个词属于哪篇文章"，
  不要试图用它反推向量坐标。
- 白天不显示窗口；窗口内没有多展品切换 UI（`exhibits.ts` 里加一项就是一个组件，
  但 v1 硬编码取 `[0]`，等真有两件以上再谈切换）。

---
## 8. 交互与几何

几何证据一律用 playwright 打**线上首页 + 临时注入新版 CSS** 再 `getBoundingClientRect` 实测
（一次性脚本不入库）；展示柜的列宽与首屏高度预算由 `frontend/tests/home-hero.test.py` 按同一条
式子算期望值（见 §8.1）。

### 8.1 卡片几何：住在右列里，宽度由列宽给

展示柜**不再是一个自己算坐标的窗口**——20261001 那次"搬到视频下面"之后，
`left: calc(8vw + 450px)` / `bottom: 18.7vh` / 高度公式，以及 `≤1300px`、`≤1100px` 两个断点
**整节作废**（`Vitrine/index.sass` 头注原话："旧几何**已随搬家作废**"）。现在它是
`.heroRight` 右列里的**第二张卡**：

```
.heroRight   width: min(38vw, 520px, max(300px, calc((100vh − 上留白 − 下留白 − 24px − 8px) / 1.1875)))
  .heroPanel   4:3              手账内页（视频）
  .vitrine     16:7  margin-top: 24px，宽度吃列宽 100%
```

- **列宽那条 `min(…)` 是三选一**（`ContentHome/index.sass` 的 `.heroRight`）：`38vw` / `520px`
  是"窄桌面不挤爆左列标题"的上限（标题 `clamp()` 上限时约 534px）；`max(300px, (100vh −
  上下留白 − 32px) / 1.1875)` 是**按剩下的高度反算宽度**——右列高 = `1.1875 × 列宽 + 24`
  （内页 4:3 的 0.75 ＋ 间隙 24 ＋ 展示柜 16:7 的 0.4375），**严格正比于宽度**，所以"让首屏
  装进一屏"只有反算这一条结构性解法（20261003 用户第 1 条「签名和下翻按钮必须下滚才能看见」）。
  ⚠️ **`1.1875` 是推导线、不是随手一填**：改内页的 `aspect-ratio` 或展示柜的高度比，必须回来
  重算它，`frontend/tests/home-hero.test.py` 第 ① 组按同一条式子算期望值。手机档（≤768px）
  整条覆盖成 `width: 100%`——375×667 上没有任何宽度能救。
- **放大态是这一列里的 `position: fixed` 弹层**（`.vitrine.is-zoomed`，`width: min(90vw,1180px)`）。
  `.heroRight` 自带 z-index ⇒ 它自己就是一个层叠上下文，所以放大时整列要抬到
  `z-index: 200`（`body.exhibit-zoomed`）：不抬这一下，置顶缎带与那条粉/薄荷交界胶带会
  画在弹层**上面**。
- **滚轮穿透靠 `pointer-events`，不靠改几何**：内联态（未放大）的图谱整块不吃指针事件
  （`Vitrine/index.sass` 的 `.vitrine:not(.is-zoomed) .vit-body { pointer-events: none }`）
  ⇒ 鼠标停在卡片上往下滚，事件直接穿透到页面、正常翻页；点开卡片放大之后才是
  "拖动旋转 / 滚轮穿云 / 双击跳文章"（此时页面滚动本来就已被锁死）。
  ⚠️ **不要再引入"默认锁定 + 悬停浮现解锁按钮 + 毛玻璃"那套机制**（曾经有过，已整块删除：
  `engine.ts` 的 `setLocked` 与 `index.sass` 的锁定层一起）；"窗口占屏大"不等于要收窄几何。
  数值判据见 `frontend/tests/wordgraph_render.py` 第 8 条（滚轮缩图谱、页面不动）。
- **两条禁令落在 `Vitrine/index.sass` 头注**：① 不用 `backdrop-filter`（原因见 §7）；
  ② `overflow: hidden` **不许**写在 `.vit-3d` 上——它是 `transform-style: preserve-3d` 的容器，
  overflow 是分组属性、会把它强制拍平成 flat，翻页动效直接消失；圆角与裁剪一律下沉到
  `.vit-face`。
  要再加宽加高，先看这两处。

### 8.2 滚轮穿云：到底之后继续前进，退回时先退位移

相机 = **锚点 + 穿云位移**（`cam.target = anchor + flight`）。只有 `dist` 一个自由度的话，
缩到底（`DIST_MIN = 0.4`）之后相机就绕着锚点打转，永远进不到团里：

| 常量 | 值 | 依据 |
|---|---|---|
| `DIST_MIN` | 0.4 | 必须能进到点云内部（实测 max 半径 1.066） |
| `DOLLY_SCALE` | 1.2 | 点云半径量级（1.066）。**不能拿 dist(0.4) 当尺度**——那样一格只走 0.06，穿团要 37 格，等于没解决"进不去" |
| `FLIGHT_MAX` | 3 | 3.0 早已在团外，留这个上限只是兜底 |

`wheelStep(dist, flightLen, deltaY)` 三分支（导出成纯函数，node 里可断言）：

1. 还能缩 → 只缩 `dist`，位移不动；
2. `dist` 到底 + 上滚 → `dist` 保持，沿视线前进（`dollyBy` = `DOLLY_SCALE·sign(t)·(1−e^{−|t|})`）；
3. 有位移 + 下滚 → **先沿"回锚点"方向退位移**，退完才缩 `dist`。

第 3 条是这套模型的关键：退位移走的是"回锚点"方向而不是 `−视线`，所以**转过视角再滚回来位移也精确归零**
（无头实测 `0.00e+00`），不需要额外的"我是不是该停止穿云"状态判断。
`dollyBy` 里那个 `|t|` 是必须的：直接写 `DOLLY_SCALE·(1−e^{t})` 会让"滚进去再滚回来"漂 15%
（`1−e^{−0.16}=0.1479` vs `1−e^{0.16}=0.1735`），单测 `== dollyBy / wheelStep ==` 锁死这条。

手感：一格 ≈ 0.177 世界单位，穿整团（直径 ≈2.13）约 **12 格**；从默认机位 2.6 一路滚到穿出去 ≈ **24 格**。
滚出去了怎么办 → 见 8.5 的复位按钮。

判据是"**进团 → 变稀 → 空**"这个形状，不是某张按格数记的像素表：像素列的绝对值会随默认
机位平移（机位从 4.3 拉到 2.6 之后，"到底"从 ≈15 格提前到 ≈12 格），照格数去对必然对不上。
线上验收脚本（1440×900，量"滚轮格数 → 画面非背景像素"）就是按这个形状判的。

读法：滚到底时相机已经进到点云里（`dist=0.4`），画面里是深处那一半的点。
再往下进入穿云段：点从身边掠过、画面逐格变稀；**彻底穿出后画面会空**。
空画面是这套模型的正常终点（不是 bug），出口是复位按钮。

### 8.3 单击选中 + 邻边高亮

- 单击（`moved ≤ 4px`）→ `setSelected(hitTest(x,y))`，点空白 = 取消。**幂等、不 toggle**：
  双击的第一下会先选中，第二下再 toggle 掉就会"闪一下"。
- 选中后**双击**跳转对应文章（`a` 字段），拖动后的 300ms 内忽略双击（`DRAG_DBL_GUARD`）。
- 与选中词相连的边**单独一遍 stroke**（`hotKeys`，`lineWidth 1.4`，暖色 `rgba(255,232,168,…)`），
  悬停同理；读数卡片悬停优先、其次是选中，卡上写明"已选中 · 双击跳转这篇文章"。

> ⚠️ **热边必须单独一遍 `stroke`**：一个 path 只有**最后设的** `strokeStyle` 生效，
> 冷热边混在同一条 path 里画，等于"高亮邻边"被整片随机染色顶掉。

### 8.4 标签分层：谁的名字非显示不可

用户的两条要求：① 重要度高的词**一直**显式展示名字；② 放大到脸上的词不能还要点一下才出名字。
（生成器 §2 里 `imp = tf·idf` 归一化后的 `n` 就是"重要度"，见 §1 产物契约。
⚠️ **A 层用的不是 `n` 而是热度 `heatOf(n)`**——点的大小改由文章热度决定之后，
"大的词一直有名字、小的词反而常驻"就成了两张皮的明显 bug。与半径、字号同源。）

按优先级排五层，总预算 `LABEL_MAX = 50`（C 层不受限）：

| 层 | 内容 | 位置 | 说明 |
|---|---|---|---|
| C | 查询命中 / 悬停 / 选中 | `hard` + `force` | 当前焦点，连一个空位都没有时也照画 |
| N | 选中词的邻居（按相似度降序，取自该点的**全部**边——每点的边数不是 3，见 §2 那条注） | `hard` | 线亮了名字要跟上 |
| Z | **贴脸的**：相机距它 ≤ `NEAR_LABEL_D = 1.5` 世界单位且落在画布内 | `hard` | 最多 10 个，按距离由近到远 |
| A | 全局**热度**前 `LABEL_A = 22` | `hard` | 用户要的"一直显式展示"（现按热度，同上） |
| B | 其余按**由近到远**补位到 50 | 撞了就让开 | 拉近自然揭示更多；查询聚焦时让位 |

两个必须守住的点：

- **"贴脸"不能用投影半径当判据**。点半径公式是 `(1.7+3.1·√heatOf(n))·(dist/depth)`——在 target
  平面上恰好等于括号里的值（≤ 4.8px），**放大只是把点摊开、并不会让点变大**，所以"半径 ≥ 8px"
  这类阈值永远够不到，Z 层会变成死代码。判据是"相机离它 ≤ `NEAR_LABEL_D` 世界单位"且**落在画布内**
  （画面外的"近"不是"贴脸"，否则贴边词的名字会被夹到画布边缘画出来）。
  ⚠️ 阈值取 **1.5**：1.0 时机位要推到 `dist ≈ 1.9` 才出第一批标签，而默认机位是 2.6 ⇒ 默认视角下
  候选恒为 0 个；2.0 又会在默认机位就常年占满 Z 层的 10 个名额（Z 层优先级高于 A 层常驻）。
- **B 层必须从最近的点往回补**。它复用了画家算法的深度序数组（远→近），照原序走等于把名字发给
  背景深处那几个小点，眼前的大点反而没名字。
- 位置候选：右 → 左 → 上 → 下，`hard` 层挨个试；贴边的词夹回画布内。
  ⚠️ 候选位不能只有"右 / 左"两个：第二次调用经常撞上同一个已占位置而失败，前排词会被旁边词的
  名字顶掉。

**同一帧里同一个词只画一个标签。** 分层各自独立调 `take()`，而一个词可以同时是
① 查询命中（C 层 `force`）、② 选中词的邻居（N 层 `hard`）、③ 相机贴脸（Z 层 `hard`）、
④ 热度前 22（A 层 `hard`）——没有去重就会同帧画出两个（最多 3 个）标签，四向候选位还会放大它。

纪律：`take()` 开头 `if (labeled.has(i)) return false;`、放下时 `labeled.add(i)`；
`labeled` 是**每帧复用**的 `Set`（与 `placed` 一起在 `draw()` 开头 `clear()`）。
层序 C→N→Z→A→B 不变 ⇒ "先画者胜"正是要的语义——**留下的是最强的那次调用**
（C 层的 `force` 亮色，而不是 A 层的暗色补位）。
证据 `/tmp/wg-labels.mjs`（18 条，反证见 §6）：去掉这行短路后命中帧立刻出 `Python×2`。

### 8.5 复位按钮与隐身检索框

- **回到默认视角**：`.wg-home`（用户给的十字准星 SVG，`fill="currentColor"`），位置在**定位按钮上方**
  （`.wg-tools` 排在 `.wg-queri` 之前），`title/aria-label="回到默认视角位置"`。
  `home()` = 清查询高亮 + 清穿云位移 + 回 `HOME_CAM`；**选中保留**（选中是对"哪个词"的注意，与视角无关）。
  没有它，滚轮穿出去之后就是"迷路"——这是穿云功能的必要配套。
- **检索框隐身**：默认 `opacity: 0` + `translateY(4px)`，`:hover` / `:focus-within` / `.is-on`
  （正在检索或已有命中 chips）时显现；`@media (hover: none)` 下常亮（触屏没有 hover 概念）。
  隐身的只是**检索框**，窗口其余部分与交互不受影响（未登录访客照常拖动/缩放/双击）。

### 8.6 缩放区间

点云半径实测（400 词）：种子 `1d1323374540` 是 `max 1.066 / p99 1.058 / p90 0.937 / p50 0.751 /
min 0.122`；线上那份 `4b43643ac308` 是 `max 1.049 / p99 1.012 / p90 0.949 / p50 0.767 /
min 0.135`——**重出一次图这组数就会动**（语料变了 UMAP 就重排），所以下面那条推论要连着
"半径量级 ≈1"读，而不是钉死 1.066。
旧 `DIST_MIN = 1.7` ⇒ **相机永远在点云外面**，"放大"到极限连最外层的点都进不去——
这就是"还没放大多数就到极限"的定量解释（不是错觉）。

| 常量 | 旧 | 新 | 依据 |
|---|---|---|---|
| `DIST_MIN` | 1.7 | **0.4** | 必须能进到点云内部（< 实测 max 1.066） |
| `LOCATE_DIST_MIN` | 1.9 | **0.8** | 小簇取景不该被下限顶到远处；测试断言"全部命中点在视锥内"仍成立 |
| `DIST_MAX` | 9 | 9 | 未动 |
| 滚轮步长 | — | `exp(deltaY·0.0016)` | 一格（Chrome deltaY=100）≈17%，当前默认 2.6 → 0.4 约 **12 格**（旧默认 4.3 → 0.4 是 15 格） |

抽成导出纯函数 `zoomBy(dist, deltaY)` 就是为了让这套手感在 node 里可断言
（`tests/wordgraph-engine.test.mjs` 的 `== zoomBy ==` 段 9 条，含"推到最近端 ≤20 格"、
"两端夹紧不越界"、以及**乘性步长精确可逆**——拉近再拉远要回到原距离，否则来回滚会漂）。

### 8.7 未选中时的连线基线

边按相似度分 4 档，每档透明度是 `base = A + B·t`（`t = (b+0.5)/EDGE_BUCKETS`），
**现行 `0.045 + 0.45·t`** ⇒ 四档 **0.101 / 0.214 / 0.326 / 0.439**。

⇒ **以后要调亮度就整体乘一个系数（A、B 同乘），别单独动其中一个。** 单独压最弱档或抬最强档
都是"按下葫芦浮起瓢"——这条曲线的形状不用改，只该改高度；档间比例、分档观感、与压暗系数
0.22 的关系都靠它保持不变。

两条边界**没动**：选中/悬停时无关边的 `×0.22` 压暗系数、热边单独一遍 stroke 的暖色那一路（§8.3）。
线宽仍是 `0.5 + 1.1·t`。

线上记录器读到的是经过 8 位量化后的值（`0.113→29/255=0.1137`、`0.503→128/255=0.502`），
**是量化不是算错**（§6）。证据 `/tmp/wg-labels.mjs` 第二段（反证见 §6）：它从录音机 ctx 里
读出各档真实 alpha，断言最弱档 ≈0.101、最强档 ≈0.439、压暗后 ≈0.022（0.101×0.22）。

### 8.8 检索结果 chips：两条各归各的规矩

**① "点了不定位"是数据问题，不是几何问题**：chip 上的词来自 agent 索引的小写原形，
图谱节点是显示形，精确匹配会把它们全丢掉。唯一修法是 `wordKey()` 单一来源（§4.3 末尾）。

**② 卡片位置对 `.wg-foot` 的顶边，不对固定像素**：`.wg-card` 是 `.wg-foot` 的最后一个子元素
（`position:absolute`，不参与流），定位 `bottom: calc(100% + 8px)`。
`.wg-foot` 是底边钉住的列（检索框 33 + 工具行 26 + 间距 6×2 + 内边距 10+8），
**它会随 chips 换行、note 提示而长高** ⇒ 基准必须是"foot 的顶边"，写死 `bottom: 92px`
这类数字一定会被 chips 撞上。可以直接在线上断的不变式：**`.wg-card` 的底边 ≤ `.wg-foot` 的顶边**。

**③ `.wg-foot` 的行序固定为 tools → note → chips → querri。**
⚠️ **任何新增的行都必须加在 `.wg-chips` 之上**：`.wg-foot` 是 `gap: 6px` 的列，DOM 顺序即视觉顺序
——插在 chips 与检索框之间的行有多高，那两者之间的空档就有多大（曾经是 `6+26+6 = 38px`，
中间杵着一个孤零零的小圆按钮）。没有 chips 时行序看起来一样（复位按钮与提示行仍依次落在
定位按钮正上方）；有 chips 时它们都上移到 chips 之上。note 摆在自己的标签上方也读得通——
"这一批标签是降级匹配来的"。

### 8.9 角标 = 向量数据库更新时间

角标显示**向量库更新时间**，格式 `2026年09月17日 UTC+8 13:20:55`（**只显示时间，不带
「向量库」前缀**，prefix 放 `title`）。

- 数据源是 `manifest.json` 的 `built`（§1.1）——那个字段就是产物的构建时刻。
  `loader.ts` 的 `loadManifest()` 负责把它透出来（模块级缓存，65B 的请求不必重复发），
  `exhibits.ts` 的 `badge` 是 `() => string | null | Promise<...>`。
- 格式化在 `exhibits.ts`：正则抓 `^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})` 再拼中文年月日，
  **不做时区换算**（`built` 本来就是 `+08:00` 本地钟面）。取不到就返回 null ⇒ 不渲染角标，
  不会出现 `undefined年`。
- 时间串比一个「新」字长得多，所以 `.vit-badge` 用 `flex: none` + `nowrap` + `tabular-nums`
  （数字等宽，避免每次重出图字宽跳），`.vit-hint` 用 `min-width: 0` + 省略号
  （窄窗口上先压提示、不把标题栏顶破）。

### 8.10 标题栏文字对齐：`line-height` 必须显式且两边一致

**规矩：标题栏里共用同一个行高 `$bar-line: 16px`，两边都显式写，且比两边字体自然高都大。**
两个元素各按各的规则算行盒时必然错位——`.vit-title` 13.5px 用 `line-height: normal` 时，
行内中文回退体的度量会把行盒撑高且**往上长**（标题整体下移）；`.vit-badge` 10px 用
`line-height: 1`，10px **小于字体自然高（≈11.7px）** ⇒ 半行距为负，基线完全由主字体 ascent
决定（角标偏上）。共用 16px 后两边半行距为正且对称，实测残差降到 **0.75px**（同字号固有残差）。
药丸高度**没变**（仍是 16px：原来是 `3 + 10 + 3` 含 padding，现在是 `0 + 16 + 0`）——
只有文字在药丸里的位置被修正。

> ⚠️ **默认容器里验证不了这一类问题**。改 `line-height` / 字号 / 字体栈时若怀疑对齐，必须先在
> 无头浏览器里注入真实中文字体（`https://fonts.googleapis.com/css2?family=Noto+Sans+SC`，需可外网
> 访问）再量墨迹中心——容器里 `fc-list | grep -ci cjk` 为 0 时 Chromium 拿 `.notdef` 方块顶替，
> 方块的行盒度量不会被撑高，症状会消失。夹具的另一半同样重要：**旧规则那一次必须真的复现出偏差**
> （≥1.5px），否则说明字体没加载、第二次测量是假的阴性。

### 8.11 点的尺寸与透明度：为什么必须有夹取带

点的半径与透明度都带着**当前机位**的 `dist`：

```
r     = (1.7 + 3.1·√heatOf(n)) · (dist / depth)  // depth = 该点到相机的距离
alpha = clamp(1.35 − depth / (dist·1.6), 0.5, 1)
```

`dist` 一路能滚到 `DIST_MIN = 0.4`，于是团外看着正常的点，飞进去以后按 `dist/depth` 一起塌：
dist 0.4 时 depth 1.5 的点比例只有 0.27 ⇒ 4.8px 的大词点缩成 1.3px，再叠上 alpha 的下限，
就成了背景里的暗点。**"距离感"本身是想要的**（远的暗一点小一点），不能用"取消透视"来修。

修法是给两个量各加一条夹取带：

| 常量 | 值 | 作用 |
|---|---|---|
| `POINT_SCALE_MIN` | 0.62 | `dist/depth` 的下限（−38%） |
| `POINT_SCALE_MAX` | 1.4 | 上限，贴脸点的比例会到 6.7，不夹会画成大色块 |
| `POINT_ALPHA_MIN` | 0.5 | 取代原来写死的 0.3 |

⚠️ **夹取带在当前默认机位（`HOME_CAM.dist = 2.6`）下是真的会夹到东西的**——相机近了、
点云半径没变，最近那批点的比例被推过 1.4。撰写时按线上产物（`4b43643ac308`，400 词）
复刻公式量到：`dist/depth` 范围 `0.718…1.451`，**12/400 越过上界**、0/400 低于下界、
**9/400 的 α 被 0.5 下限抬起**（α min 0.480）。**这是既定行为、不是回归**：方向都是
"变大、变清楚"，且只涉及离相机最近的一小撮点，而夹带要解决的问题（飞进团里时点塌成
看不见的暗点）不受影响。改默认机位时这组数会动——判据该是"受影响点占比不超过某个比例"，
不是重新要求 0。

⚠️ **换热度口径会改半径但不会改"夹没夹到"**：`k = dist/depth` 由点的位置与机位决定、
`alpha` 只吃 `depth`，**跟"点被画多大"无关**（`√heatOf` 只乘在括号项上）。

回归锁在 `tests/wordgraph-engine.test.mjs`（探针放在世界 −z 上 ⇒ `depth = dist + 1`，
比例 = `dist/(dist+1)`：团外 dist=5 → 0.833 必须**不触带**；团内 dist=0.4 → 0.286 必须被抬到 0.62）。
线上验收（`/tmp/vit_accept_d.py` B/C 段，记录器读线上 bundle 真的画了什么）：滚到底
（`dist → 0.4`，见 §8.2）后 α min/p05 **0.500/0.500**、半径 min/p05 **1.22/1.26**
——旧公式在同一位置会给 α 0.30、半径 p05 0.87。

---

## 9. 为什么不加向量数据库（结论：不加）

- **数据量**：400 词 × 1024 维 = 1638400 B 裸 float32（1.56 MiB），已经 L2 归一化，
  检索就是一次点积 + top-k。纯 Python（`array` + `map(operator.mul, ...)`，C 循环）**实测 ~15ms**
  （见 §1.2），稳态端到端 ~200ms（§4.1），瓶颈在 embedding 那一次网络调用，不在检索。
- **成本**：Qdrant/Milvus 在这类小机器上要多 200~400MB RSS（worker 数本来就是按内存上限调出来的，
  见 [deployment-and-ops.md](deployment-and-ops.md) 的《资源画像与容量》）+ 一份要运维的常驻服务
  + 一份要备份的数据目录。
  换来 **0** 召回率提升、**0** 延迟收益。
- **真正需要的"管理"是版本与新鲜度，不是索引结构**：产物是可重生成的派生物，
  谁都知道当前线上是哪一版最关键——那由 `build_id`（文件名/URL 标识）+ `built`（角标，§8.9）
  + 质量报告（`eval/report/wordgraph/<ts>_build.json`，§2）三件套给出。
- **什么时候再议**（同时满足才谈）：语料 > ~10k 块、查询 P95 > 300ms、需要元数据过滤
  （如"只在编程类文章里搜"）。那时该做的是**先量再选**，不是先上服务。

---

## 10. 弃权闸：加过，又拆了

**结论先行：BM25 弃权闸已整体拆除，线上不存在。** 这一节留下结论与代价，因为"给向量检索
装一张会说'不'的嘴"是个很自然会再冒出来的想法。

### 10.1 为什么加过

纯余弦 top-k **没有"无结果"这个状态**——随便敲一句"红烧肉怎么做"，它照样返回 8 个词并带
一串分数，界面在很笃定地指给你几个毫不相干的词。最直觉的修法是卡一个分数阈值，实测否掉了：
域内 8 条查询的 top1 余弦落在 [0.363, 0.805]、域外 10 条落在 [0.228, 0.364]——**两带重叠**，
远端余弦本身很挤，没有可用的绝对阈值。于是改走词法判据：查询串里切不出任何图谱节点词就弃权。

### 10.2 为什么拆了（三条，都是实测）

1. **闸的词典是展示层词表，不是语料词表。** 节点词是为画图好看挑的（每篇词数配额 + POS 筛 +
   黑名单），"画图选词"一改，搜索边界就跟着漂——检索的正确性被一个视觉决策绑架。
2. **中文匹配是单向的，注定够不着正确节点。** 词表词必须**出现在查询串里**才算命中，所以
   查询里写 `兼容` 永远到不了节点 `兼容性问题`（实测 `浏览器兼容问题` 被闸弃权，而向量侧
   top1 = **0.6371「兼容性问题」**——正确答案就在那儿，被闸挡在门外）。
3. **域内查询被拦成空返回。** `物联网` / `单片机` / `IOT` / `嵌入式` 全部弃权、chips 一个不剩，
   而同一时刻向量侧给的是 `遥测` `传感器` `设备` `mqtt` `esp32` 一群**正确节点**；
   `物联网` 加两个字变 `物联网设备` 就过闸了（因为 `设备` 是节点词）——脆得没有道理。

**换个判据也救不了**：把词典从展示词表换成全语料词表，只是从 341 词扩到 2527 词，单向匹配
与"画图选词耦合"两条缺陷原样保留。而按"词在不在语料里"分三组量下去，**没有任何阈值能同时
放过组②（词全在语料里、一个都不是节点，top1 最高 0.6371）的高分正确答案、又拦住组③
（纯域外，top1 最高 0.3525）**——两组咬在一起。

### 10.3 所以现在的契约（比拆闸前更简单）

- 后端不再有"我判定图里没有这句话"这种**结论态**：`reason` 只剩**五种故障**语义
  （`empty_query` / `artifact_missing` / `embed_failed` / `dim_mismatch` / `space_mismatch`），
  调用方一律按"服务不可用"处理 → 前端降级到本地关键词匹配。
- 前端回到**两态**：`LocateHit[]`（路通了）vs `null`（路不通）。没有 `no_match` 那个特例。
- 域外查询照样返回"最近的几个词"。**判断相不相关交回给访客**，不由一个词法部件代判——
  宁可让访客看见 8 个不太相关的词自己判断，也不让正确答案被静默吞掉。

**拆掉的部件**（要找它们去 git 历史）：`rag/wordgraph.py` 的 `_load_gate` / `match_terms` /
`_bm25` 与 `no_match` 分支、`build_word_graph.py` 的 `--gate-only` / `write_gate_index`、
产物 `data/word_graph/bm25.json`、`test_wordgraph_gate.py`（48 项）及 `eval.yml` 里那一步、
前端 `locate.ts` 的三态契约。

## 11. 检索态的恢复：跳转文章后回到首页

**丢的不是检索结果**——`/graph/query` 是无状态的，随时能重算；丢的是前端这一份 UI 态。
`WordGraphExhibit` 把 `q` / `chips` / `sel` 放在组件 `useState` 里，而点图谱里的词是
react-router 的 **SPA 跳转**（`onActivate → nav('/article/<id>')`）：首页整棵组件树卸载，
状态随组件销毁，回来重新挂载就是一张白纸。换 MPA/多标签页解决不了这件事——新开标签是
**全新的组件实例**，状态照样是空的（除非配持久化，那就绕回下面这套）。

两处存储，分工不同（`wordgraph/remember.ts`）：

| 存储 | 存什么 | 作用 |
|---|---|---|
| URL 参数 `?wg=` | 查询串 | **跨页面跳转的真源**：浏览器后退回首页时参数还在、刷新也在、链接可分享。用 `setSearchParams(..., { replace: true })` 写——一次检索不占一条历史，而被替换的正是当前这条首页记录，所以从文章页后退回来照样带着它 |
| `sessionStorage`（键 `wgSearchState`） | 查询串 + 命中列表 + 选中词 | 命中列表是**花过一次 embedding** 的东西：有它就能不等网络直接还原画面。也是点站内「首页」链接（URL 上没有 `wg`）回来时唯一能救回状态的地方。按标签页隔离，新开标签是干净的 |

**恢复优先级**（`decideBoot`）：URL 参数优先；URL 有查询串但缓存是**另一次**检索 ⇒ 只恢复
查询串，命中列表重新去取；URL 上没有 ⇒ 用本标签页缓存。

**坑与纪律**：

- 恢复必须**等引擎就绪**（`data` 到了引擎才建），且按**引擎实例**记账（`bootDoneRef`）——
  引擎重建后能重放一次，而用户随后的手动检索不会被它盖回去。
- 清空（chips 上的 `×` / Esc）要**同时**清 URL 参数、缓存和 `bootRef`，否则回首页又被恢复出来。
- 恢复走 `focus()`（与手动检索同一条路）而不是自己拼相机：相机永远由命中列表现算
  （`cameraFor`），两处各记一份必然漂移。
- **每条检索结果都要落账**，恢复那一路也一样。恢复时"重新检索"只发生在 URL 与缓存
  对不上的时候，那次结果才是当前这次检索的正确答案；不写回去，缓存就停在旧查询上，
  之后从**无参数**的首页回来会还原出上一次的检索。
- 缓存解析**任何一处不对劲就整份丢弃**（坏 JSON / 空查询串 / 命中项不是 `{w:string,s:number}`），
  退化成"没有缓存"，绝不半信半疑地用；URL 里的查询串按 64 字截断（URL 是外来输入）。
- `sessionStorage` 读写全部包 `try`：隐私模式/禁用存储时功能退化成"不恢复"，不影响检索本身。

回归：`node tests/wordgraph-remember.test.mjs`（33 项：截断、脏数据过滤、优先级、异常兜底）。

---

## 12. 线上产物运维

§1.1b 讲的是两条通道的规矩，§5 讲的是"改代码的人怎么出图"。这一节是**接手的人真正会用到的
那几件**：怎么确认线上是哪一代、重出图之后什么会立刻生效什么不会、出坏了怎么退回去。

### 12.1 确认线上正供哪一代

```bash
# ① 浏览器/前端拿到的那一份（这条就是唯一真源——前端先问它、拿不到才回落静态种子）
curl -s https://saudade.site/api/public/graph/manifest
# ② 同源的另一半：agent 查询侧读的向量产物（两边的 build_id 必须一致，见下）
python3 -c "import json;d=json.load(open('saudade-blog-agent/data/word_graph/index.json'));print(d['build_id'],d['count'],d['built'])"
# ③ 磁盘上还剩哪几代（脚本只留最近 2 代，见 §1.1）
ls -lt saudade-blog-agent/data/word_graph/web/
```

**两边的 `build_id` 必须相等**：展示产物（`graph-<id>.js`）与查询产物（`vectors.f32` 等）出自
同一次运行，manifest 的 `v`、`index.json` 的 `build_id`、`graph-<id>.js` 的文件名段是**同一个
哈希**（`sha1(JSON(不含 v))[:12]`）。撰写时线上是 `4b43643ac308` / 400 词 / `built
2026-10-04T00:47:44+08:00`，`site=https://saudade.site`——三条命令给出的应该是同一个 id。
对不上说明有人手工动过其中一份（比如只补了 manifest，没重跑向量），那是**比"图旧"更糟的状态**：
前端画的是 A 代的词，双击跳的文章 id 也是 A 代的，而查询侧按 B 代返回词。

### 12.2 重出图之后：什么立刻生效、什么要等、什么不用管

> ⚠️ **改了 `EMBEDDING_*`（或 `QWEN_BASE_URL` 那一族）之后必须重建一次图。**
> 建图与查询共用一份配置（§1.2），改配置那一刻起**新的** embedding 空间就生效了，
> 而盘上那张图还是旧的 ⇒ 查询侧 `space_mismatch`、前端退回本地关键词匹配（明着降级，
> 日志里有一条 WARNING；不用重启、不用改任何东西，重建一次即恢复）。
> 只有"新配置指向同一端点同一模型"（比如只是把 `QWEN_*` 换成等价的 `EMBEDDING_*`）才不用重建。

| 那一层 | 重出图后 | 说明 |
|---|---|---|
| 前端产物（浏览器） | **立刻** | 文件名带新 hash，`manifest` 是 no-store ⇒ 没有"要清缓存"这回事（§1.1 最后一段） |
| agent 查询侧（内存） | **当次查询就换** | `wordgraph._load()` 比对 `build_id`，变了整份热替换（§4.5）——但**每个 worker 各换各的**，4 个 worker 意味着最多 4 次查询各付一次重载 |
| Rust 的查询结果缓存 | ⚠️ **不失效，最长 10 分钟** | `src/routes/graph.rs::CACHE_TTL = 600s`，键是**小写查询串**、只缓存成功结果；重建**不会清它**。所以刚重建完那几分钟里，重复过的老查询会拿到**上一代**的词表 |

那条 10 分钟的窗口**症状很轻但会让人怀疑是不是坏了**：chips 照常显示（返回什么就显示什么），
可是点它不飞、不亮——因为 `setHighlight` / `cameraFor` / `findIndex` 都按 `wordKey` 去
**当前产物**里找那个词（§4.3 末尾、§8.8），新图里已经没有的词会被静默丢掉。**换一个从没查过的
词、或者等 10 分钟，就好了**；真要立刻干净，`systemctl restart saudade-rust`（重发一次新查询
也一样，缓存只按查询串命中）。这不是要修的 bug——cache 的键里没有 build_id，是当初按
"产物是静态的"设计的；把它加进键里是个可用的小改进。

### 12.3 出坏了怎么退回去

**先说最要紧的一条：质量门不过时脚本根本不写盘**（`build_word_graph.py` 的 `if not args.force`
那一段在 `write_artifacts` **之前**）⇒ 那种情况下的"回滚"是**什么都不用做**：manifest 还指着
上一代，首页照常是那张好图。真正需要回滚的是这两类：

- **`--force` 硬出的产物上了线**（保真度或节点数没过门）；
- **重建成功但结果不想要**（比如漏了排除 id、`--min-chars` 填错、语料拉错站点）。

回滚有两条路，按"上一代还在不在"选：

```bash
# ① 快路：上一代还在磁盘上（脚本只留最近 2 代，所以这条只在最近一次重建之前有效）
W=saudade-blog-agent/data/word_graph/web
ls -lt $W                      # 找上一代的 graph-<旧id>.js 与它的字节数
#    把 manifest.json 改回 {"v":"<旧id>","file":"graph-<旧id>.js","bytes":<实际字节数>,
#                            "site":"https://saudade.site","built":"<旧那一代的时间>"}
#    bytes 只用于后台页显示，`built` 用于角标——都要跟那份产物自己写的一致，别顺手改
#    （角标是给访客看的"图谱更新时间"，写错就是页面上挂着一个假时间）

# ② 慢路：上一代已经不在磁盘上（被后面几次重建的保留策略删掉了）
#    重新出一次图，参数照上一次的 argv 填（后台页展开「这次实际跑的命令」就有），
#    想省 API 成本就别带 --refresh（md5 缓存会让重跑几乎零成本，§5）
```

**回滚只回展示产物是不够的**：查询侧的向量 `data/word_graph/{index.json,vectors.f32,…}` 是同一
目录之上的另一份，靠 `build_id` 与展示产物对账（§12.1）。所以正确的做法是**重跑一次**（快路里
改 manifest 只该在"只是不想要这一版图、查询侧无所谓"时用，比如纯粹是 `--min-chars` 调错）。
另外重建走的是 agent 自己的目录，**不产生任何 git 变更、也不必重新部署**——所以"回滚"这件事
从头到尾都不涉及 CI。

### 12.4 站点闸在重建这一侧怎么走

后台页那个「归属站点」输入框**默认填的就是发起重建时浏览器的 origin**（`GraphRebuild.tsx`），
所以自己重建一次就天然通过运行期那道闸（§1.1）。两种填错的后果不一样：

- **留空** = 产物不署名 ⇒ `loader.ts::siteMatches` 对**任何**站点都放行（老产物语义）。
  单人站无所谓；**公开模板/多域名部署会退化成"谁的首页都画你的文章"**。
- **填错**（比如填了 `http://localhost:3000` 却从 `https://example.com` 访问）⇒ 展品显示
  「文章向量空间尚未为本站点生成，请在后台重建」，**图不出来**，而日志里没有任何错误
  （判定在前端、是"设计成不显示"而不是故障）。改法是重新点一次重建（页面会把当前的 origin
  带上），不是去改产物文件。
- ⚠️ **必须带 scheme**——`GraphRebuild.tsx` 提交前就拦（提示「归属站点要写成带协议的地址
  （例如 https://你的域名）；裸域名前端解析不了、产物会写进去但首页永远不显示。想不署名就留空」）。
  原因是 `build_word_graph.py::origin_of()` 只在匹配到 `^https?://` 时才规整，而前端
  `loader.ts::siteMatches` 里 `new URL()` 解析不了裸域名 ⇒ 展品显示「尚未为本站点生成」
  **且没有任何错误日志**。后端那条链上没人校验这个值（Rust 只传、agent 只限长度 200），
  所以这一处前端校验是唯一的门。
