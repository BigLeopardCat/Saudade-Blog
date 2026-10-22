# 前端测试规范与迁移

应用基于 React 18、Vite 8；与 CI 对齐使用 Node 20.19 以上的 20.x。本批锁定 Vitest 4.1.0 与 Playwright 1.56.1，依赖只能来自官方 npm registry。升级需重新检查 engines/peerDependencies 和 CI，不直接安装 latest。

## 命令与门禁

在 frontend 下执行：

| 命令 | 范围 |
| --- | --- |
| `npm test` | legacy Node 套件，再执行 Vitest；不包含浏览器或 lint |
| `npm run test:unit` | tests/unit 中的 TS 模块/React 组件回归 |
| `npm run test:unit:watch` | 本地交互开发 |
| `npm run typecheck:tests` | 单元与浏览器测试分别进行严格类型检查 |
| `npm run test:browser` | Playwright 真 Chromium/真实模块与组件，隔离 HTTP 边界 |
| `npm run lint` | 产品与 TS 测试；禁止提交 test.only/describe.only |
| `npm run test:legacy` | 迁移期间保留的 JS 协议/架构/工具回归，不代表完整业务覆盖 |

开发机首次运行浏览器测试需 `npx playwright install --with-deps chromium`。CI 单独安装 Chromium 和中文字体，固定 Asia/Shanghai、zh-CN，workers=1；浏览器失败阻止部署，保留 trace/截图 7 天。PR 另在 GitHub runner 验证生产构建，不在共享生产主机运行构建。

## 新测试标准

- 纯逻辑直接 import 生产模块，验证输入、输出与边界；不再手工 esbuild 临时 bundle 或正则抠函数后 new Function。
- React 行为使用真实 React/Testing Library，按可访问名称操作控件，验证输入保留、目标归属、真实请求 payload 和用户反馈。不要维护自制 useState/useEffect/JSX runner。
- Ant Design 的 RTL 用例可使用官方 StyleProvider 的 server 模式关闭 CSS-in-JS 注入，避免 jsdom 选择器计算病理开销；组件与事件仍真实执行，样式与布局必须由浏览器覆盖。
- 页面布局、真实网络适配器与浏览器生命周期用 Playwright。沙箱使用真实源码、不复制产品 DOM；所有 API 显式拦截，未知网络请求失败，禁止连接生产接口。
- 使用可控 Promise/时钟、固定随机种子与语义等待。避免 waitForTimeout；仅必要动画采样可明确限定等待理由。
- 单元默认超时 10 秒，legacy 每套 90 秒，browser 每条 60 秒；禁止 focused tests。共享 setup 清理 React、计时器与存储，测试不得依赖顺序。
- 失败产物不入库。基线截图必须明确命名、固定字体并经人工核验，不把 failed 日志当作视觉基线。
- 新用例应能捕获对应故障，等价重构应保持绿。测试文件数、断言数不能换算为覆盖率或端到端流程数。

## 本批替代关系

notes-list-state、asset-url、visitor-key 的行为迁到 TS，noteTags 和统计 API 边界独立直接测试；原跨语言访客请求头/白名单、编辑器编码接线另列小型 legacy contract，尚未用行为覆盖前不删除安全边界。

PR #34 复用沙箱设计及 Axios/公告场景，重写为内存静态 allowlist，不复制整棵源码。先验证新浏览器行为等价，再退役对应 Python；其他 Python、widget 经典 JS 与后端架构约束分批处理。#34 仍作来源记录，尚未整体替代前不关闭或删除分支。

本轮也修正聊天跨日夹具：明确构造昨日 23:59 与今日 00:01，并断言间隔确为两分钟。

后续批次：迁移草稿及文章乱序的手写 hooks/源码切片测试；真实路由 smoke 与河灯完整场景接入；合并重复卡片/主题像素锁；将后端架构、工具与 widget 检查拆成独立入口。当前第一批不代表所有旧测试已标准化。

## 重场景与等待预算

富 Ant Design 分类组件每例上限 30 秒、RTL 异步等待上限 5 秒；用真实用户事件和控件恢复状态推进流程，不用通知出现推断请求已经结束。其余单元默认仍为 10 秒，无自动重试。静态通知在单元夹具内保持到断言完成并在每例后销毁，避免自然过期影响反馈断言。

河灯以一个 TS Playwright 桥接入口执行现有真实路由 driver，同一套断言仅维护一份；这是过渡接线，driver 尚未全部重写成 TS fixture。测试覆盖 WebGL 着色器成功、无编译 overlay、窗口焦点与视口、未登录、放灯失败留输入/重试待审、减少动效/隐藏暂停恢复、横竖屏、加载错误/重试/空态。软件 WebGL 冷启动预算 360 秒，CI 不录屏；截图与日志只进失败 artifact。后续可逐步拆原生 TS fixture，但此入口已由 PR browser job 必跑。
