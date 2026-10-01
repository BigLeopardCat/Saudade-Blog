# 博客前端

Saudade Blog 的 SPA：博客页面（首页/文章/留言板/关于）、后台管理、以及看板娘"泠月喵"
的聊天面板。

> 项目整体的说明在[仓库根 README](../README.md)，参与开发的通用约定（提交格式、测试、
> 环境变量）在 [CONTRIBUTING.md](../CONTRIBUTING.md)。**这份文件只讲前端。**

## 技术栈

- **框架**：React 18 + TypeScript
- **构建**：Vite 5（`vite.config.ts`）
- **UI**：antd v5（后台）、手写 sass（前台）
- **状态**：Redux Toolkit（`src/store/`）
- **请求**：axios（`src/apis/axios.tsx`，baseURL 走 `src/utils/runtimeApi.ts`）
- **内容渲染**：bytemd（markdown）+ KaTeX（公式）+ highlight.js
- **看板娘**：`public/live2d-widgets/`，纯 JS 子模块，不走 React 打包

## 本地跑

```bash
npm ci
npm run fetch:widget    # ★ 不能省：看板娘前端的源码住在 agent 仓（见下）
npm run vendor:live2d   # ★ 不能省：看板娘运行时的三份第三方产物不入库（见下）
npm run dev             # Vite 开发服务器（默认为 http://localhost:5173）
```

两个 ★ **顺序不能换**：`fetch:widget` 整树替换 `public/live2d-widgets/`，而
`vendor:live2d` 往它的 `vendor/` 子目录里写。

少了 `fetch:widget` 的话，博客本身照常跑、聊天面板也在，但**看板娘一帧都不画**
（控制台报 `chat-stream.js` 之类 404）；少了 `vendor:live2d` 是同一个症状、报
`/live2d-widgets/vendor/pixi.min.js` 加载失败。两者的来历见下面
[看板娘那一节](#看板娘与聊天面板publiclive2d-widgets)。

开发模式**不用配代理**：`src/utils/runtimeApi.ts` 看到端口是 5173/4173 就会把 API
指到 `http://<当前主机>:3000`。但这是跨源请求，所以后端的 `.env` 里要有：

```bash
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

**别在本机跑 `npm run build`。** 这台开发机只有 3.7 GB 内存，`vite build` 会 OOM 甚至
拖垮整机（真发生过）。构建交给 CI，本地验证用 `tsc` + `npm test` 就够了。

## 目录结构

```
frontend/
├── index.html              入口 HTML（站点身份占位符由 vite.config.ts 注入）
├── vite.config.ts          构建配置 + 站点身份注入插件
├── public/                 原样拷贝进 dist 的静态资源
│   ├── fonts/              ★ 自托管图标字体（两套 iconfont + Font Awesome）
│   ├── live2d-widgets/     ★ 看板娘与聊天面板（**源码在 agent 仓**，npm run fetch:widget 就位）
│   ├── live2d_model/       Live2D 模型文件（同上，也由 fetch:widget 就位）
│   ├── cubism5/            Live2D Cubism Core（**不入库**，npm run vendor:live2d 就位）
│   ├── loading.svg         图片懒加载占位
│   └── effects.js          页面特效（樱花/雨/雪）
├── src/
│   ├── frontHome/          博客前台页面（首页、文章页、页脚、头部…）
│   ├── pages/              Dashboard（后台）/ Login / RiverBoard（留言板）
│   ├── components/         公共组件
│   ├── apis/               接口封装
│   ├── store/              Redux
│   ├── utils/              工具（含 runtimeApi、siteUrl、chatMarkdown）
│   └── assets/             走打包的图片与字体
└── tests/                  测试套件（见下）
```

## 看板娘与聊天面板（`public/live2d-widgets/`）

这里**不是 React 代码**，是独立加载的纯 JS 模块，由 `boot.js` 作为唯一入口按依赖序加载。
React 那边只有一个 38 行的注入器（`src/components/Live2dAgent/index.tsx`）负责插一个
`<script>`。

```
boot.js                  入口：防重入 / 资源链加载 / 子模块组装 / 初始化时序
renderer.js              看板娘渲染层（自研：DOM 骨架 / 拖拽 / 工具条 / 口型 / 入场）
chat-core.js             纯函数（无 DOM 依赖）
chat-render.js           消息渲染（markdown、代码高亮、贴纸）
chat-engine.js           数据层（拉历史、发消息、会话态）
chat-stream.js           交互层（SSE 解析、命令执行、发送/停止）
chat-session.js          会话列表 UI 壳
widget.css               看板娘与聊天面板样式（自研，2012 行）
vendor/                  pixi.js / pixi-live2d-display 的 UMD 产物（**不入库**，见下）
```

整个目录是**自研代码**。20261001 之前这里住着上游 `stevenjoezhang/live2d-widget`
（GPL-3.0）的渲染层，与博客自身的 GPL-2.0 不兼容，已整体替换：现在是
**pixi.js + pixi-live2d-display**（都是 MIT）直接驱动 Live2D 模型，约 350 行。

### 这些文件的源码**不在本仓**（20261002 起）

它住在 [saudade-blog-agent](https://github.com/BigLeopardCat/saudade-blog-agent) 的
`frontend/` 下：**代码以 MIT 分发**（那个仓根部的 Python 部分是 Apache-2.0；只有 MIT 才与本站
的 GPL-2.0 兼容，所以两边分得很清），**美术资源（模型、贴图、面板图标、角色形象设计）以
CC BY-NC-SA 4.0 分发**——可自用可改、不可商用、改作须同样协议，见那边的
`frontend/ASSETS-LICENSE.md`（它**不是** OSI 开源许可）。本仓不跟踪这棵树，只在
[widget.lock.json](widget.lock.json) 里钉一个提交号：

```bash
npm run fetch:widget          # 按 pin 稀疏检出，落到 public/ 下与从前**完全相同**的路径
npm run fetch:widget:check    # 只校验不改盘（本地那份与 pin 逐字节相同吗）
```

路径一字不动是**有意的**：nginx 那两个 1 年 immutable 的 `location` 块、仓库外的设备控制台、
一批按路径读文件的测试、`src/routes/chat.rs` 的 `include_str!` 全都因此零改动。

> ⚠️ 要改看板娘的渲染/面板代码，**去 agent 仓改**，再回来把 `widget.lock.json` 的 `sha`
> 与两棵 `trees` 一起换掉。**忘了换 = 改动永远不上线，而且没有任何东西会变红。**
> 这条链是本仓最安静的一个失效点，所以那个文件头注里也写着同一句。

渲染链路的三个第三方件（都不是本仓代码，两个是 MIT、一个是专有）：

| 文件 | 来源 | 许可 |
|---|---|---|
| `public/live2d-widgets/vendor/pixi.min.js` | `node_modules/pixi.js` | MIT |
| `public/live2d-widgets/vendor/cubism4.min.js` | `node_modules/pixi-live2d-display` | MIT |
| `public/cubism5/live2dcubismcore.min.js` | [Live2D 官方](https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js) | **Live2D 专有**，不适用本仓的 GPL-2.0 |

**这三份都不进 git**（体积 + 许可），克隆后跑一次就位：

```bash
npm ci
npm run vendor:live2d          # 从 node_modules 拷两份 + 从官方 CDN 取第三份（按 sha256 校验）
npm run vendor:live2d:check    # 只校验不写盘
```

`vite build` 只拷贝 `public/` 下**真实存在**的文件 ⇒ 缺了这三份，dist 里就没有它们，
看板娘整个不渲染（而且是静默的：聊天面板照常工作）。CI 在 `npm run build` 之前会自动跑
`vendor:live2d`，官方哪天换核心版本会在构建这一步**响亮地红**（哈希对不上），
免得新核心悄悄进生产——Cubism Core 换版本不报错，只是画得不一样。

工具条那 5 个图标是 **Font Awesome Free 6.7.2**（Icons: CC BY 4.0），SVG 路径内联在
`renderer.js` 的 `ICONS` 里，版权归 Font Awesome 项目所有。

> 「复刻上游的观感」这件事是**逐帧比对过**的：替换前后各跑一次
> `tests/live2d-render.test.py`，两侧全绿，且同一机位截图的差异 < 0.1%（只剩呼吸/尾巴
> 动画的相位差）。改 `fitModel()` 的取景公式前请先跑那个套件。

### ⚠️ 改这里的文件要 bump 版本号

nginx 对 `/live2d-widgets/` 目录设了 **1 年 immutable 缓存**，不换 URL 访客永远拿旧的。
`boot.js` 里有个 `VER` 常量，所有子模块 URL 都拼 `?v=VER` —— **改任何子模块都要
把 `VER` 加一档**。

`VER` 有**四个同步点**（改漏一个就会出现"脚本是新的、入口是旧的"或反之）：

1. `frontend/public/live2d-widgets/boot.js` 的 `VER` 常量
2. `frontend/src/components/Live2dAgent/index.tsx` 里 `boot.js?v=` 的查询串
3. **仓库外**还有一个消费方（IoT 设备控制台 `/home/ubuntu/mqtt-demo/device-console/index.html`
   直接引 `boot.js`，没有 React 打包）
4. `frontend/tests/spa-navigate.test.mjs` 里手抄的那份字面量（有断言钉着，漏了会红）

> 版本号是部署细节，**不写进 commit message**。

`widget.css` 与 `vendor/*` 的缓存也走 `?v=VER`（由 `boot.js` 自动拼接，不用手改）。
但 `public/cubism5/` 与 `public/live2d_model/` 是**裸路径**加载的（没有 `?v=`）——换模型文件
或换 Cubism Core 只能改文件名 / 改路径，`?v=` 帮不上忙，immutable 一年。

### SSE 帧协议

聊天走 `POST /api/chat/stream`，一条 SSE 流里混着**回复正文**和**控制帧**，帧前缀形如
`__END__` / `__EXEC__` / `__CMD__` / `__RESET__` 等。这个协议**三端共用**
（Python agent → Rust 转发 → 这里的 `chat-stream.js`），改一处必须同步另外两处。
帧前缀的判定逻辑见 `src/routes/chat.rs`。

## 测试

```bash
npm run fetch:widget:check                        # 看板娘前端那两棵树与 pin 逐字节相同吗
npx --no-install tsc --noEmit -p tsconfig.json   # 类型检查
npm test                                          # node tests/xxx.test.mjs 全套
npm run lint                                      # ESLint
```

三类套件，**只有前两类进 CI**：

| 类型 | 位置 | 跑法 |
|---|---|---|
| `*.test.mjs` | `tests/` | `npm test`（`node` 直跑 + `node:assert`，没有 jest） |
| 渲染沙箱 `*.test.py` | `tests/` | 手动 `python3 tests/某个.test.py`，要 Playwright |
| 前后端契约 | 仓库根 `tests/frontend_contract/test_api.py` | **手动跑**（Python + 要活着的后端），不在 `cargo test` 里 |

渲染沙箱（真组件 + 无头 Chrome + 数值断言）跑不进 CI 的秒级 job，由
`scripts/nightly_sandboxes.sh` 夜间串行跑。依赖装法见 `tests/requirements.txt`。

> 沙箱用得上的两个坑（都踩过）：① 沙箱里只编译**单个组件**的 sass，全站 `index.css`
> 的全局规则在沙箱里不存在，几何断言会把"样式没生效"误读成"页面缺陷"；
> ② 公共 DOM stub 在 `tests/stubs/dom.mjs`，改它会影响所有套件。

## 许可

本目录以 **GPL-2.0** 分发（同[仓库根](../LICENSE)）。引入新依赖前确认许可兼容性 —— 见
[CONTRIBUTING.md](../CONTRIBUTING.md) 的许可一节。

两个例外，别搞混：`public/live2d-widgets/` 与 `public/live2d_model/` 的源码在 agent 仓
（本仓只是按 pin 取产物来打包）——那里的**代码是 MIT**（与 GPL-2.0 兼容）、**美术资源是
CC BY-NC-SA 4.0**（不可商用，详见上文）；`public/cubism5/` 是**专有**许可，两个仓都不跟踪它，
构建前从官方地址取。
