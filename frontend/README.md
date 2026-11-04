# 前端

React、TypeScript、Vite、Ant Design、Sass 与 ByteMD。版本以 `package.json` 和锁文件为准。

## 本地运行

使用仓库 `.node-version` 指定的 Node 版本：

```bash
cd frontend
npm ci
npm run fetch:widget
npm run vendor:live2d
npm run dev
```

开发态 `/api` 由 Vite 代理到后端。API 与受保护图片地址分别通过 `VITE_HTTP_BASEURL`
和 `VITE_CDN_BASEURL` 配置，解析逻辑统一在 `src/utils/runtimeApi.ts`。
共享生产主机不执行本地生产构建，构建由 PR / 发布 CI 完成。

## 目录

| 目录 | 职责 |
| --- | --- |
| `src/pages/` | 后台、登录与独立页面 |
| `src/frontHome/` | 公共布局、首页与文章页面 |
| `src/components/` | 可复用组件及其状态模块 |
| `src/apis/` | HTTP 适配器 |
| `src/store/` | Redux 状态 |
| `src/utils/` | 共用逻辑、资源地址和浏览器适配 |
| `tests/unit/` | 真实模块和 React 单元测试 |
| `tests/browser/` | Playwright 浏览器回归 |

## 看板娘资源

`public/live2d-widgets/` 和 `public/live2d_model/` 的源码由独立的
[saudade-blog-agent](https://github.com/BigLeopardCat/saudade-blog-agent) 仓库维护。
本仓不直接修改这些目录；先在 Agent 仓提交，再更新 `widget.lock.json` 中的提交与子树哈希。

```bash
npm run fetch:widget
npm run fetch:widget:check
```

`fetch:widget` 验证提交和子树后将源码放到原有 public 路径，保留 vendor 与手工备份。
`vendor:live2d` 单独取得 Cubism Core、Pixi 与渲染适配器。Cubism Core 不提交到源码树。

`src/components/Live2dAgent` 只负责入口加载，`boot.js` 按依赖顺序初始化聊天和角色。
聊天模块、SSE 协议和 Agent 内部结构在 Agent 仓维护，不在本仓重复列清单。

### 资源版本与缓存

宿主入口使用 `widget.lock.json` 的 SHA 作为缓存键，子资源继承该版本。
组件改动不更新 pin 就不会被本仓发布；不要另设一份前端版本号。
详细资源和部署缓存规则见 [运维手册](../docs/deployment-and-ops.md)。

## 验证

```bash
npm test
npm run typecheck:tests
npm run test:browser
npm run lint
```

测试分层、隔离要求和现有旧套件的迁移规则见 [前端测试规范](../docs/frontend-testing.md)。
优先扩展已有真实组件/浏览器用例；临时几何探针放系统临时目录，不修改正式断言或连接生产 API。

## 许可


本目录以 **GPL-2.0** 分发（同[仓库根](../LICENSE)）。引入新依赖前确认许可兼容性 —— 见
[CONTRIBUTING.md](../CONTRIBUTING.md) 的许可一节。

两个例外，别搞混：`public/live2d-widgets/` 与 `public/live2d_model/` 的源码在 agent 仓
（本仓只是按 pin 取产物来打包）——那里的**代码是 MIT**（与 GPL-2.0 兼容）、**美术资源是
CC BY-NC-SA 4.0**（不可商用，详见上文）；`public/cubism5/` 是**专有**许可，两个仓都不跟踪它，
构建前从官方地址取。
