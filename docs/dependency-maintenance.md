# 依赖更新与 PR 维护

Dependabot 保留每周扫描和安全更新，不自动合并。运行依赖、测试工具和构建/Lint 分组；Markdown 管线只聚合 patch，minor/major 独立迁移。Router 成组更新。RustCrypto 的 hmac/sha2/digest 成组；JWT 主版本单独评审。Cargo 通用组只聚合 patch；esbuild、pixi-live2d-display 等 npm 0.x 依赖只聚合 patch，minor 更新独立评审。分组不是安全等级，也不能把 0.x minor 视为无破坏性更新。

工作流中的外部 Actions 固定官方发布标签对应的完整提交 SHA，注释保留标签供 Dependabot 识别。更新时核对发布说明和输入兼容性。当前 Rust 1.92 显式使用 `-D warnings`，避免 setup-rust-toolchain v2 默认依赖 Cargo 1.97 的告警选项而削弱旧闸门。checkout 不保留凭据，部署 job 不启用自动 npm 缓存。

浏览器 runner 固定 Ubuntu 24.04，系统依赖仅从 Ubuntu 官方 HTTPS 源安装，保留软件包签名校验，避开 hosted runner HTTP 镜像持续低速下载。系统依赖安装设 6 分钟上限，apt 单次连接/读取等待 30 秒、最多重试 3 次。中文字体从 Noto 官方仓库的固定提交获取单个简体中文文件并验证 SHA256，避开 Ubuntu 镜像 61MB 字体包下载；字体与 Chromium 下载分别设 4 分钟上限，整体 20 分钟。失败继续阻止部署。先辨别安装失败与测试断言失败，只有前者可以在修复环境后重跑；不得用忽略退出码消除红灯。

CI 在编译前运行经 SHA256 验证的 actionlint，检查工作流结构和表达式。PR 仍执行类型检查、Rust/真实 PG 测试、前端测试、ESLint、生产前端构建和浏览器回归。主分支通过同样检查才构建发布，是否上线以 build-info.json 的 sha 为准。

## 2026-10-23 清理依据

已关闭 #2、#4、#5、#6、#7：主分支分别已有 qs 6.16.0、source-map-js 1.2.2、baseline-browser-mapping 2.11.28、DOMPurify 3.4.17、glob 所需 brace-expansion 1.1.21。每个 PR 留有版本说明。关闭重复 PR 不关闭安全告警。

#8/#9/#10 的 Actions 更新由本轮统一迁移并固定提交；合并验证后关闭重复提案。#41 的运行依赖/测试/构建混合组按新分组重新提出。#26/#27 是真实的 RustCrypto trait 兼容性错误；#16 是 Markdown 管线类型迁移，需通过独立实现与测试处理，不能仅重跑旧检查。


## 本轮处理状态

- 已合并 CI/分组规范 #46、RustCrypto 迁移 #47、Markdown 管线 #56、公式契约补充 #58，以及字体来源 #57 和 HTTPS 系统源 #59。
- 运行依赖 #52、工具链 #51、测试工具 #50、Tokio 补丁 #25 和 Prism 高亮安全更新 #18 已各自通过完整 CI 后合并。
- TypeScript 7（#54）的 ESLint peer 不兼容、Vitest 5（#53）的 Node 类型要求，以及无限滚动组件 7（#55）的实际交互验收，分别保留为迁移草稿；说明写在对应 PR。不使用 force 安装，不屏蔽安全更新。
- 旧 KaTeX PR #3 无法由机器人按当前配置 rebase，已按机器人说明关闭以重新生成；这不表示 KaTeX 已升级。后续 KaTeX 更新仍需验证公式渲染。
- 历史失败/取消记录保留。判断当前状态须查看最新提交的检查，不能把旧红灯视为当前主分支失败。
