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
npm run dev      # Vite 开发服务器（默认为 http://localhost:5173）
```

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
│   ├── live2d-widgets/     ★ 看板娘与聊天面板（见下）
│   ├── live2d_model/       Live2D 模型文件
│   ├── cubism5/            Live2D Cubism Core 运行时
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

这里**不是 React 代码**，是独立加载的纯 JS 模块，由 `autoload.js` 作为唯一入口按依赖序加载。
React 那边只有一个 38 行的注入器（`src/components/Live2dAgent/index.tsx`）负责插一个
`<script>`。

```
autoload.js              入口：防重入 / 资源链加载 / 子模块组装 / 初始化时序
chat-core.js             纯函数（无 DOM 依赖）
chat-render.js           消息渲染（markdown、代码高亮、贴纸）
chat-engine.js           数据层（拉历史、发消息、会话态）
chat-stream.js           交互层（SSE 解析、命令执行、发送/停止）
chat-session.js          会话列表 UI 壳
waifu.css                看板娘与聊天面板样式
live2d-widget.js         看板娘画布、口型、入场动画
```

### ⚠️ 改这里的文件要 bump 版本号

nginx 对 `/live2d-widgets/` 目录设了 **1 年 immutable 缓存**，不换 URL 访客永远拿旧的。
`autoload.js` 里有个 `VER` 常量，所有子模块 URL 都拼 `?v=VER` —— **改任何子模块都要
把 `VER` 加一档**。

`VER` 有**三个同步点**（改漏一个就会出现"脚本是新的、入口是旧的"或反之）：

1. `frontend/public/live2d-widgets/autoload.js` 的 `VER` 常量
2. `frontend/src/components/Live2dAgent/index.tsx` 里 `autoload.js?v=` 的查询串
3. 仓库外还有一个消费方（IoT 设备控制台直接引 `autoload.js`，没有 React 打包）

> 版本号是部署细节，**不写进 commit message**。

`waifu.css` 和 `waifu-tips.json` 的缓存靠 `?v=`；但 `waifu-tips.json` 是裸名加载的，
换内容时要同时改文件名（新名即 cache-bust）。

### SSE 帧协议

聊天走 `POST /api/chat/stream`，一条 SSE 流里混着**回复正文**和**控制帧**，帧前缀形如
`__END__` / `__EXEC__` / `__CMD__` / `__RESET__` 等。这个协议**三端共用**
（Python agent → Rust 转发 → 这里的 `chat-stream.js`），改一处必须同步另外两处。
帧前缀的判定逻辑见 `src/routes/chat.rs`。

## 测试

```bash
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

GPL-2.0（同[仓库根](../LICENSE)）。引入新依赖前确认许可兼容性 —— 见
[CONTRIBUTING.md](../CONTRIBUTING.md) 的许可一节。
