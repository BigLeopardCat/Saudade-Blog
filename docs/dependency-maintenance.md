# 依赖维护

版本事实源为 Cargo、npm 和 Python 各自的声明及锁文件。CI、开发指南和运行工具版本保持一致，不把维护者本机镜像写入锁文件。

升级先检查 engines、peerDependencies、框架公开 API 和许可证，再运行对应类型、单元、数据库、浏览器及生产构建检查。模型 SDK 或持久框架升级额外验证协议、checkpoint 恢复及未知结果处理。

Dependabot 按运行、测试和构建依赖分组；不因提交来自机器人而跳过检查。Actions 固定不可变提交，工作流经 actionlint 校验。安全升级需要保留原失败证据及验证，不能以忽略退出码解决。

安装或网络失败与业务断言失败分别处理。缓存只加速安装，不改变锁定版本；重跑前先核实失败原因。公开 PR 不使用生产密钥，部署仅在主线检查完成后执行。

`Dependency audit` 用 cargo-deny 检查 Cargo.lock 锁定且实际启用的依赖图，包含测试依赖和
各目标平台，不排除指定包、不忽略安全公告；保留 Cargo metadata、功能依赖树和 RustSec 原始
JSON 结果。锁文件还可能登记未启用的可选后端，不能仅凭锁文件条目判断它们进入了程序。
前端用 npm audit 检查锁定的生产和开发依赖。RustSec 的安全漏洞和 npm 的中危及以上漏洞
阻止对应作业通过；工具或数据库不可用不算通过。信息性提示仍需维护者复核。
这类检查不替代源码、权限与部署安全验证，不自动升级或忽略报告中的依赖。

## 开发工具的安全兼容

ESLint 使用支持 minimatch 11 的版本，TypeScript ESLint 的剩余旧版约束仅在
`@typescript-eslint/typescript-estree` 内覆盖为修复版本，避免影响其他依赖。
该解析器调用的 `minimatch(path, pattern, {dot: true})` 由真实 project-service
默认项目允许列表回归验证，完整类型检查、ESLint 和浏览器构建也须通过。
上游支持 minimatch 11 后移除这项局部覆盖；不忽略
[glob 放大拒绝服务告警](https://github.com/advisories/GHSA-g3hv-75wg-m249)。
