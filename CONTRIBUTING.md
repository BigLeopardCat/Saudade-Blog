# 参与开发

共享会话规则见 [AGENTS.md](AGENTS.md)，项目概览见 [README.md](README.md)。运行和接口文档与代码不一致时，以代码为准并同步修正文档。

## 1. 仓库边界

- `src/`：Rust / Axum / SeaORM 后端，数据库为 PostgreSQL。
- `frontend/`：React / Vite 前端；Node 版本与 `.node-version`、`frontend/package.json` 保持一致。
- `scripts/`：迁移、部署、巡检；`deploy/`：部署模板；`docs/`：当前契约与操作说明。
- `iot/`：可选设备集成，默认关闭，安装与配置见 [iot/README.md](iot/README.md)。
- `saudade-blog-agent/` 是独立仓库，不随本仓部署。看板娘前端也在该仓维护；本仓通过
  `frontend/widget.lock.json` 的提交和子树哈希固定版本，修改组件必须同步此锁文件。

## 2. 本地运行

需要 Rust（最低版本见 `Cargo.toml`）、Node（版本见 `.node-version`）和 PostgreSQL。
数据库必须使用专用开发实例，不要用测试或初始化命令操作生产数据库。

### 数据库与配置

复制 `.env.example` 到 `.env`，填写数据库连接、JWT 和本机服务配置，不提交密钥。
数据库名称使用 `saudade_blog`，字符排序规则按基线文件要求设置。

使用 `scripts/migration/pg/0000_schema.sql` 建立基线，再按下面命令打印的顺序执行编号迁移：

```bash
python3 scripts/migration/pg/ci_schema_files.py
```

执行迁移时启用 `psql -v ON_ERROR_STOP=1`。新增表使用应用角色执行，以保持表和序列所有权一致。
新结构直接编写幂等的 PostgreSQL 迁移，不重新生成基线。MySQL 脚本和切库工具已移除，当前数据库入口统一在 `scripts/migration/pg/`。
具体部署步骤见 [部署手册](deploy/README.md) 与 [运维手册](docs/deployment-and-ops.md)。

### 后端与前端

```bash
cargo run
```

另开终端：

```bash
cd frontend
npm ci
npm run fetch:widget
npm run vendor:live2d
npm run dev
```

开发服务器将 `/api` 代理到本机后端。`fetch:widget` 必须先于 `vendor:live2d`，避免覆盖第三方渲染运行时。
Python Agent 是可选服务，配置和启动方式见其独立仓库的 README。

### 改代码时的几条硬约束

1. 维护者的工作机同时是生产服务器：不在该机运行 `vite build`、`cargo build --release` 或 `cargo clean`。
   全量 Rust 编译、链接、测试及批量依赖安装交给 CI；该机只执行有资源边界的定向检查。
   生产构建交给 CI；开发检查使用 `cargo test`、TypeScript、单元测试与隔离浏览器测试。
2. 提交前逐文件核对，不用 `git add -A` 或 `git commit -a`，避免带入其他会话的改动。
3. SSE、执行回执字段或工具契约改变时，同时核对 Rust、Python Agent 和浏览器端。
4. 迁移必须幂等；权限、事务、并发和兼容性约束用简短注释说明，不在源码保留修改流水账。
5. 浏览器测试拦截 API，不向生产环境写入。临时产物放系统临时目录，不提交日志、截图或构建产物。

## 3. 提交约定

采用 [Conventional Commits 1.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。维护者默认使用中文描述，类型和 scope 使用英文；接受英文贡献，不要求逐行双语。

```text
type(scope): 描述
type(scope)!: 不兼容变更的描述
```

类型使用小写：

`feat` · `fix` · `refactor` · `perf` · `test` · `docs` · `style` · `build` · `ci` · `chore` · `revert`

- 标题不超过 60 个字符，说明最终变化；模块明确时使用小写 scope，如 `chat`、`auth`、`rag`、`ui`、`eval`。整个仓库的改动可省略 scope。
- `feat` 表示新增能力，`fix` 表示修复缺陷，`perf` 表示性能或成本改善，`refactor` 表示保持行为的结构调整。`style` 仅用于代码格式，界面变化按功能或修复归类。
- 正文按需说明原因、必要取舍和影响，与标题空一行；可以使用自然段或列表。保留真实贡献者信息和标准 Git trailers。
- 不兼容的接口、配置或数据变化使用 `!` 或 `BREAKING CHANGE:`，并在 PR 中说明迁移与发布顺序。

示例：`fix(chat): 恢复暂停任务后的执行状态`、`perf(rag): 减少重复向量化请求`、`docs: 更新本地开发说明`。

功能、修复、接口、依赖、数据库和 CI 改动通过 PR；维护者的小范围文档勘误可直接提交主线。分支使用清晰的功能前缀，编码助手默认使用 `codex/`。

PR 标题与主线提交使用同一格式，默认 Squash Merge。PR 内的临时提交不要求逐条整理；合并时由维护者确认最终标题和正文。本地钩子和 CI 共享 `.githooks/commit-msg`；PR 校验标题，主线校验新提交。

PR 描述围绕最终实现：

- 说明具体问题、改动后的行为及必要取舍；小改动一两句话即可。
- 记录实际验证命令、结果及未运行或跳过项。CI 通过、已合并和已部署分别表述。
- 涉及跨仓契约、数据迁移或发布时，列出配套 PR、固定版本、发布顺序和必要回滚步骤；不涉及的模板段落直接删除。
- 关联实际处理的 issue；保持描述与最终差异一致，省略开发过程、废弃方案和与评审无关的工作记录。

提交前检查差异、注释和敏感信息。安全问题按 [SECURITY.md](SECURITY.md) 报告，凭据及真实私有用户内容留在私有环境。

本地安装钩子：`git config core.hooksPath .githooks`。

## 4. 验证

下面是 CI 或独立开发环境的完整检查；共享生产主机只运行适用的轻量定向检查。

```bash
cd frontend
npm run fetch:widget
cd ..
cargo test
cd frontend
npx --no-install tsc --noEmit -p tsconfig.json
npm run typecheck:tests
npm test
npm run test:browser
npm run lint
```

PostgreSQL 集成测试需要独立的 `TEST_PG_URL` 和测试专用 `JWT_SECRET`；鉴权/代理测试另设
独立的 `AGENT_ASSERTION_SECRET`、`BLOG_DELEGATION_SECRET`，设备网关测试设 `DEVICE_SIGNING_SECRET`。
配置使用合成值，不复用部署密钥。
单独运行时缺少环境配置不代表已验证数据库行为；CI 使用独立数据库服务。
前端测试分层、超时和夹具要求见 [前端测试规范](docs/frontend-testing.md)。

## 5. 许可

本仓代码按 [GPL-2.0](LICENSE) 分发；第三方依赖与资源声明见 [THIRD-PARTY.md](THIRD-PARTY.md)。
看板娘代码的 MIT 许可与美术资源的 CC BY-NC-SA 4.0 分开适用，完整声明保留在项目 README 和 Agent 仓。
Cubism Core 为专有运行时，不提交到源码树，由 `vendor:live2d` 从官方源取得。
引入依赖、字体或图片前核对相应许可，不用代码许可替代资源授权。

## 6. 文档入口

- [安全边界](docs/security-boundary.md)：身份、权限、限额与信任边界。
- [部署与运维](docs/deployment-and-ops.md)：拓扑、服务管理、日志、回滚与备份。
- [路线图](ROADMAP.md)：当前工作、待办和约束。
- 各接口契约保留在 `docs/`；一次性审计、修复记录和生成过程可从 Git 历史查阅，不另留副本。

## 7. 跨仓协作与交接

每个任务使用独立工作树，先核对用户给定的完整提交或配套 PR；未指定时更新本仓主线
`cn_sora_blog` 和 Agent 主线 `main`。不要以本机另一个旧 checkout 的 HEAD 代替任务基线。
会话间通过已推送的分支、完整提交和 PR 交接，不相互复制未提交文件或覆盖共享分支。

| 固定版本文件 | 作用 | 何时更新 |
| --- | --- | --- |
| 本仓 `frontend/widget.lock.json` | Agent 的组件提交及两棵子树哈希 | 采用组件或模型资源变更时 |
| Agent 的 `.github/host-contract.json` | Agent 离线测试读取的公开宿主源码 | 采用宿主测试契约变更时 |

先推送源仓提交，再更新消费方的锁。组件提交与当前 Agent 服务提交可以不同；仅改 Python、
配置或文档，不要求组件 pin 追到 HEAD。更新组件 pin 后用 `npm run fetch:widget -- --check`
验证提交和子树，实际构建前按 `fetch:widget`、`vendor:live2d` 顺序准备资源。

三端协议改动在配套 PR 中列出兼容范围与合并/发布顺序；鉴权配置等不兼容变更须协调切换，
不能以某一仓 CI 通过替代两仓接线验收。交接说明该提交的检查结果、未运行项、推送/合并/
部署各自状态及剩余工作，不把聊天中的“已完成”当作版本证明。
