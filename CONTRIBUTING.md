# 参与开发

项目概览见 [README.md](README.md)。运行和接口文档与代码不一致时，以代码为准并同步修正文档。

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
新结构直接编写幂等的 PostgreSQL 迁移，不重新生成基线，也不执行 `scripts/migration/` 下的旧 MySQL SQL。
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
   生产构建交给 CI；开发检查使用 `cargo test`、TypeScript、单元测试与隔离浏览器测试。
2. 提交前逐文件核对，不用 `git add -A` 或 `git commit -a`，避免带入其他会话的改动。
3. SSE、执行回执字段或工具契约改变时，同时核对 Rust、Python Agent 和浏览器端。
4. 迁移必须幂等；权限、事务、并发和兼容性约束用简短注释说明，不在源码保留修改流水账。
5. 浏览器测试拦截 API，不向生产环境写入。临时产物放系统临时目录，不提交日志、截图或构建产物。

## 3. 提交约定

提交使用 `type(scope): 描述`，首行不超过 60 字符，正文与首行空一行。
允许 `feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`perf`、`ci`，不加共同作者署名。
正文写清最终行为、必要取舍和验证范围，省略讨论过程和废弃方案。

```bash
git config core.hooksPath .githooks
```

前端与协议变更提交 PR，填写仓库模板中的验证结果。没有运行的检查保持未勾选；
涉及另一仓库时附上配套 PR 和固定版本。部署链路见 [运维手册](docs/deployment-and-ops.md)。

## 4. 验证

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

PostgreSQL 集成测试需要独立的 `TEST_PG_URL` 和测试专用 `JWT_SECRET`。
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
