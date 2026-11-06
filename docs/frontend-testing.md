# 前端测试

Node 版本使用 `.node-version`；库版本以 `frontend/package.json` 和锁文件为准。所有依赖来自官方 npm registry，公开 PR 不需要部署密钥或服务器环境。

## 命令

在 `frontend` 目录运行：

| 命令 | 范围 |
| --- | --- |
| `npm test` | Node 协议/工具契约与 Vitest 单元/组件回归 |
| `npm run test:unit` | TypeScript 逻辑和 React 行为 |
| `npm run typecheck:tests` | 单元和浏览器测试类型检查 |
| `npm run test:browser` | Playwright Chromium、真实模块与组件 |
| `npm run lint` | 产品代码及 TypeScript 测试 |

首次浏览器验证执行 `npx playwright install --with-deps chromium`。CI 固定 zh-CN、Asia/Shanghai 和中文字体，单 worker；失败保留 trace 和截图，不自动重试掩盖失败。构建、Rust 和真实 PostgreSQL 检查也在公开 PR 中执行。

## 新测试

纯逻辑直接导入生产模块；React 行为使用 Testing Library 和真实控件。样式、滚动、命中区域、图片比例和浏览器生命周期由 Playwright 验证，不用 jsdom 的尺寸证明布局正确。

共享 browser sandbox 打包真实源码并提供内存静态 allowlist；业务接口显式拦截，未知网络与未捕获页面错误均失败。只制造合成数据，不复制产品 DOM，不加载生产凭据。

采用可控时钟、Promise 和语义等待；避免固定等待代替状态验证。测试清理计时器、存储和组件，不依赖执行顺序。单元默认 10 秒、legacy 套件 90 秒，浏览器按场景限定；禁止 focused tests。

`test:legacy` 覆盖尚未由等价行为测试替代的 Node 跨语言/工具契约。河灯完整路由经 TypeScript Playwright 桥接现有 driver；软件 WebGL 冷启动预算 360 秒。

替换测试时先证明新测试能捕获原故障，再退役实现形状断言；安全、授权、保存版本和并发边界必须保留。测试数量不等于任务覆盖率，隔离组件回归不等于线上 E2E。
