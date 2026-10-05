# 参与开发

面向想在本地把它跑起来、或者想提 PR 的人。项目整体在 [README.md](README.md)，
这里是"怎么动手"。

> 遇到文档与代码不一致：**以代码为准**，然后顺手把文档改了。

---

## 1. 仓库里有什么

| 目录 | 是什么 | 语言/栈 |
|---|---|---|
| `src/` | 博客后端：文章/分类/标签/留言板 API、登录鉴权、聊天链路中枢 | Rust（Axum + SeaORM） |
| `frontend/` | 博客前端 SPA（**不含**看板娘与对话面板，见下） | React 18 + Vite 5 + antd + sass |
| `saudade-blog-agent/` | 看板娘的"大脑" | Python（FastAPI + 手写 LangGraph） |
| `scripts/` | 部署、迁移、巡检脚本 | bash / python |
| `docs/` | 设计文档（安全边界、评测分层、词图等） | Markdown |

**`saudade-blog-agent/` 是一个独立的 git 仓库**，被本仓 `.gitignore` 忽略。它的改动
不在本仓的 CI 里，也不随本仓部署。只有你要动"看板娘会怎么答话"时才需要它。

**看板娘前端（`live2d-widgets/` + `live2d_model/`）也住在那个仓里**（20261002 起），
**代码以 MIT 分发、美术资源以 CC BY-NC-SA 4.0 分发**（见 §5）。本仓不跟踪它们，只在 `frontend/widget.lock.json` 里钉一个提交号，构建前
由 `npm run fetch:widget` 取回到 `frontend/public/` 下与从前**完全相同**的路径。
要改看板娘的渲染/面板代码，去 `saudade-blog-agent` 仓改，再回来把那个 sha 换掉——
**忘了换，改动就永远不会上线，而且没有任何东西会变红**（`frontend/widget.lock.json` 里
有同一句提醒）。

还有一个不在本仓库的东西（README 的架构图里有）：IoT 设备服务 `device-service`
（源码未公开，本仓 [iot/device-service/](iot/device-service/) 有单元模板与接口契约）。
它是**可选件**，不装不影响其余部分——设备控制台 `iot/device-console/` 已经收进本仓。

---

## 2. 跑起来

### 2.0 前置

- **Rust** stable（`cargo --version` 能跑就行）
- **Node.js** ≥ 18
- **MySQL** 8
- **Python** 3.10+（只有要跑 agent 时才需要）

### 2.1 建库与账号

数据库名**必须叫 `saudade_blog`** —— `scripts/migration/*.sql` 里凡是**带了** `USE` 语句的
（绝大多数）都写死这个名字，改名要逐条改。有三份**没有** `USE`——
`chat_conversation_20260903.sql`、`execution_log_20260904.sql`、`password_reset_token_20260921.sql`
——所以建库那一步是显式把库名传给 `mysql`（`mysql ... saudade_blog < "$f"`），
**不要靠脚本自带的 `USE`**：那三份在别人的库上会报 "No database selected"。

> ⚠️ **带 `USE` 的那些迁移会把你连的库顶掉。** `USE saudade_blog;` 会把连接**切到那个库**，
> 所以 `mysql <你的库> < 某个迁移.sql` 读到那一行之后，后面所有语句都打到 `saudade_blog` 上，
> 而且 mysql 不会报错。下面这个脚本对每个文件都先剥掉 `USE` 行、再显式点名库名，
> 剥不干净就中止 —— 自己写循环时要把这一层照抄过去。

建库用一个脚本（[`scripts/migration/fresh_install.sh`](scripts/migration/fresh_install.sh)），
**不要**自己把 `*.sql` 按顺序全跑一遍：

```bash
# 第一个参数是库名。库名叫 saudade_blog 是对的（见上面那段），脚本因此要你明确声明一次
# ——它默认拒收这个名字，免得在产线机器上打错字时静默改了那个库。
ALLOW_PRODUCTION_NAME=1 bash scripts/migration/fresh_install.sh saudade_blog -uroot -p
```

**为什么不能"按文件名顺序把 `*.sql` 全跑一遍"**：`0000_base_schema.sql` 是
**20261001 的生产库快照**——那天（含）之前所有增量迁移的效果**已经在里面了**，而它们大多
是无保护的 `ALTER TABLE … ADD COLUMN`（没有 `IF NOT EXISTS`）。照单全跑会在半路撞上
`ERROR 1060 Duplicate column name`，以及 `chat_conversation_20260903.sql` 的
`ERROR 1050 Table 'conversation' already exists`。那些报错的迁移本身没有坏，
只是它们属于快照之前、不该再跑一次。

所以规则是：**基架 = 快照，之后只补快照日期之后的迁移**。日期就是文件名里的
`_YYYYMMDD.sql` 后缀，脚本按它筛（快照日当天及更早的一律跳过）。**加了新迁移不需要动脚本**；
将来重新导出基架时，把脚本里的 `SNAPSHOT` 改成新的导出日、并把 `0000_` 那份整体替换
（它自己的头注写着这条纪律）。

⚠️ 上面这条规则的**前提是快照完整**，而它并不总是完整：快照是生产库的导出，**生产库漏跑过的
迁移，快照里自然也没有**，日期规则又会把那份迁移静默跳过 —— 结果是"从零建库"一路建到线上
仍然是坏的（`password_reset_token_20260921.sql` 就漏过：代码从第一天起就在引用那张表，
而库里没有）。这类迁移登记在脚本的 `apply_despite_snapshot()` 名单里**强制补跑**，
门槛只有一条：**脚本必须幂等**（它会被无条件跑一遍，不看日期）。重新导出基架、`SNAPSHOT`
前移之后，名单要逐条核对、把效果已进新快照的删掉。

脚本做的四件事：拒绝把 `saudade_blog` 当目标库 → 建库（utf8mb4）→ 逐文件剥 `USE` 后应用 →
最后报出表数（**26 张基架 + 快照后迁移 ⇒ 20261004 是 29 张**：`note_comment`、
`note_comment_vote` 两张是快照后的迁移，`password_reset_token` 是上面那条例外补跑出来的）。
它**不幂等**：库里已经有表就直接拒绝（想重来就先 `DROP DATABASE`）。

再建一个**应用账号**。后端进程用它连库，不该拿 `root` 跑（`root` 只用来建库、跑迁移和救急）：

```bash
mysql -uroot -p -e "CREATE USER 'saudade_blog'@'localhost' IDENTIFIED BY '换成你自己的密码'; \
                    GRANT ALL PRIVILEGES ON saudade_blog.* TO 'saudade_blog'@'localhost';"
```

用户名要与 `.env` 里 `DATABASE_URL` 的那一段一致（`.env.example` 的样例就是这个）。
**库里没有任何地方写死它** —— 库名在迁移脚本里写死了，用户名没有；你想换个用户名，
建号之后改 `.env` 就行。（本仓的迁移脚本里**没有** `CREATE USER`/`GRANT` 语句，
所以别指望跑迁移能顺带把账号建出来。）

多数迁移都写成幂等的（`IF NOT EXISTS` / `IF EXISTS` / 靠 `migration_flags` 表打标记），
重复执行安全 —— 但**能只跑一次就跑一次**，个别脚本带数据回填，重跑会覆盖你改过的数据。

> ⚠️ **`scripts/migration/` 里混着评测夹具与一次性脚本，不要整个目录无脑跑一遍。**
> `fresh_install.sh` 跳过它们，但自己写循环时要照着同样跳过：
>
> | 跳过 | 是什么 |
> |---|---|
> | `golden_*.sql` | 评测用例的夹具（测试分类、一条待审留言） |
> | `test_accounts_*.sql` | 评测用的测试账号（`agent_test_user_*`） |
> | `user_rename_sora_*.sql` | 把作者 uid=1 的用户名改回 `sora` |
> | `user_remove_legacy_hash_account_*.sql` | 删作者库里那个遗留的哈希账号 |
> | `superadmin_role_*.sql` / `secretary_role_*.sql` / `zako_role_*.sql` | 把 uid=1 提为 superadmin / 把某个账号提为 secretary / 给某个账号授角色（`@zako='REPLACE_ME'`，不填就空转） |
>
> 前两类跑进你的库会凭空多出几个 `agent_fixture_*` / `agent_test_user_*` 账号；
> 后三类在你的库上没有对象，跑也是空转。**判断依据是文件名里的主题，不是日期。**

### 2.2 环境变量

```bash
cp .env.example .env
# 然后至少改 DATABASE_URL 和 JWT_SECRET
```

`.env.example` 里每一项都有注释说明用途与默认值。要点：

- `DATABASE_URL` 和 `JWT_SECRET` **不配就起不来**（前者 `main.rs` 直接 panic，后者登录时 panic）
- `SITE_URL` **别人部署必须改成自己的域名** —— 它在后端决定 sitemap 里的链接与 CORS 默认白名单。
  缺省值是中性占位 `http://localhost:3000`（见 `src/utils.rs::site_url`），爬虫会忽略它
- 前端那一半的站点地址走 **`VITE_SITE_URL`**（构建期变量，同名不同前缀，`.env` 里那份 `SITE_URL`
  管不着它）：`frontend/index.html` 的 canonical / og:url 占位符由 vite 在构建时替换。
  两个都要设，别只设一个

### 2.3 起后端

```bash
cargo run          # 监听 127.0.0.1:3000（只回环，靠 nginx 反代对外）
```

第一次编译要几分钟。改完代码可以用更快的检查：

```bash
cargo check
RUSTFLAGS="-D warnings" cargo check   # 严格自检（CI 没开这个，属本地纪律）
```

### 2.4 起前端

```bash
cd frontend
npm ci
npm run fetch:widget    # 看板娘前端的两棵树：源码在 agent 仓，按 pin 取回来
npm run vendor:live2d   # 看板娘运行时的三份第三方产物不入库，必须单独就位（见 5. 许可）
npm run dev             # Vite 开发服务器
```

两个 `npm run` **顺序不能换**：`fetch:widget` 整树替换 `public/live2d-widgets/`，
而 `vendor:live2d` 往它的 `vendor/` 子目录里写——反过来的话刚取到的 `vendor/` 会被抹掉。

漏掉 `fetch:widget` 的话，`npm run dev` 打得开、聊天面板也在，只有看板娘**一帧不画**，
控制台报 `chat-stream.js` 之类 404（`vendor:live2d` 也会因为找不到目录而失败）。
漏掉 `vendor:live2d` 则是同一个症状、报 `/live2d-widgets/vendor/pixi.min.js` 加载失败——
那几份第三方产物**不入库**（见 §5），必须显式取一次，否则不渲染。

开发模式下**不需要配代理**：`src/utils/runtimeApi.ts` 检测到端口是 **5173（`npm run dev`）
或 4173（`npm run preview`）**时会自动把 API 指到 `http://<当前主机>:3000`。但跨源了，
所以后端的 CORS 白名单要放开（下面两种端口都列上，用哪个都不至于当场 404）：

```bash
# .env
CORS_ALLOWED_ORIGINS=http://localhost:5173,https://你的域名
```

### 2.5 起 agent（可选）

agent 在独立仓库里，有自己的 README 与 `.env.example`。它默认跑 `127.0.0.1:8010`，
后端的 `AGENT_URL` 默认就指着那里，所以**不配也能对上**。

不跑 agent 的话，博客本身（文章、留言板、后台）一切正常，只有看板娘不会答话。

---

## 3. 测试

### 3.1 秒级套件（push 与 PR 上都会跑）

> **CI 在 PR 上只跑下面这几项，不跑部署**（20261006 起）。它在 PR 上**不需要任何 secret**，
> 所以 fork 来的 PR 一样有反馈；部署那一半要 R2 与 SSH 凭据，PR 上恒不触发。
> 即便如此，**提交前自己跑一遍**仍然值得：CI 要排几分钟，而这几条在本机是秒级的。

```bash
# 看板娘前端两棵树不在 git 里（源码在 agent 仓）⇒ cargo test **之前**必须先取
# （src/routes/chat.rs 有一条 include_str! 是**编译期**读那个 chat-stream.js 的，
#  没取到的话 cargo test 会在这里报一个看不出前因后果的编译错）
cd frontend && npm run fetch:widget && cd ..

# 后端：MockDatabase（不连库）+ 真 MySQL 那一层（见下）
cargo test

# 前端
cd frontend
npm run fetch:widget:check                        # 本地那份与 pin 逐字节相同吗
npx --no-install tsc --noEmit -p tsconfig.json   # 类型检查
npm test                                          # node tests/xxx.test.mjs 全套
npm run lint                                      # ESLint
```

> ⚠️ 本地复核 lint 时**必须**带 `--report-unused-disable-directives`（`npm run lint`
> 脚本里已经带了）：一条**多余的** `eslint-disable-next-line` 在这里判 error，
> 而它会让 CI 红 —— CI 红就意味着这次 push 什么都没部署。
>
> 另一条：`npm test` **不包含** ESLint，两者是分开的两道门。

`cargo test` 里还挂着一层**真 MySQL** 的集成测（`tests/mysql_integration.rs`），它由
环境变量 `TEST_MYSQL_URL` 门控：

```bash
# 不设 ⇒ 那几条自己跳过（本地默认如此，不需要任何准备）。
# 设了 ⇒ 真连库跑；**连不上是失败不是跳过**（静默跳过会让这道闸变成装饰）。
bash scripts/migration/fresh_install.sh saudade_it -uroot -p   # 先备一个空库（名字自取）
TEST_MYSQL_URL="mysql://root:密码@127.0.0.1:3306/saudade_it" cargo test --test mysql_integration
```

它验的是 MockDatabase **结构上验不了**的那一类：

- `SUM(<整数列>)` 返回 DECIMAL、零行时 NULL 折零、空 id 列表必须短路、几条外键真的
  插得进去 —— 最要紧的是第一条，`cargo check` 与 mock 都验不出它；
- **额度扣减的边界**（`quota::try_consume`）：`WHERE used < limit` 的最后一格恰好扣一次、
  被挡住的那一轮一个数都不许动 —— `rows_affected == 1` 这个判据是真的 UPDATE 语义；
- **会话搜索的 LIKE 转义**（`%`/`_` 要按字面匹配）与列表的置顶/倒序/命中锚；
- **额度申请的原子认领**：重复点"通过"第二刀必须零副作用（清零没再发生、通知没多出第二条）。

后三组要真 JWT 走完 `create_router` 的中间件，所以它们**自己把 `JWT_SECRET` 设上**
（`create_token` 从进程环境读密钥）。

CI 会起一个 `mysql:8.0` 服务容器跑它（见 `deploy.yml` 的 `check` job），**它门住部署**。

### 3.2 沙箱套件（要 Playwright + 无头 Chrome，**不进 CI**）

`frontend/tests/*.test.py` 是一批"真组件 + 无头 Chrome + 数值断言"的渲染沙箱。它们要
真浏览器，CI 的秒级 job 装不下，所以由 `scripts/nightly_sandboxes.sh` 夜间串行跑。

手动跑单个：

```bash
python3 frontend/tests/某个.test.py
```

> ⚠️ 这套要点无头 Chrome，内存开销大：在低内存机器上**必须串行**，不要并发起第二个 chromium。
>
> ⚠️ 判据经常依赖**环境特有的前提**（某个端口空着、某个目录存在）。跑不通时先看它自己的头注
> —— 好几个套件在开头写清了它假设什么、以及为什么。

### 3.3 其它

| 套件 | 在哪 | 说明 |
|---|---|---|
| `tests/api_tests.rs` | 本仓 | 走 MockDatabase，跟着 `cargo test` 跑（无需任何外部依赖） |
| `tests/mysql_integration.rs` | 本仓 | **真 MySQL**，跟着 `cargo test` 跑，但要 `TEST_MYSQL_URL`（不设即跳过，见 §3.1）。CI 有服务容器 |
| `tests/manual/test_api.py` | 本仓 | **手动跑**（Python，`requests`）：要一个**活着的** `localhost:3000`，登录类用例还要你自己给凭据 —— `BLOG_TEST_USER=... BLOG_TEST_PASSWORD=... python3 tests/manual/test_api.py`。不给凭据也能跑，登录相关用例自动跳过。**它不在 `cargo test` 里**，也不进 CI |
| `eval/`（agent 仓） | `saudade-blog-agent/eval/` | golden set 端到端，要真服务与真语料，按需跑 |
| `scripts/*.py` | 本仓 `scripts/` | 部署与巡检脚本（`deploy/` 下几个）**没有对应套件**，不进 CI。本仓 `scripts/` 下**没有 `eval/` 目录**——评测全在 agent 仓 |

**目录就是判据**：`tests/` 根下跟着 `cargo test` 跑（要外部依赖的用环境变量门控成"不设即跳过"），
`tests/manual/` 下是**要活服务或真凭据**、只能手动跑的。前端那两批同理：
`frontend/tests/*.test.mjs` 进 CI，`frontend/tests/*.test.py` 要无头 Chrome、走夜间沙箱。

**CI 到底跑哪几项**：见 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)。
`check` job（上面那几条检查）**任何 push 都跑**；会被 `paths-filter` 跳过的是**部署那一半**——
只改 `tests/**`、文档或根目录治理文件的 push，`build-and-deploy` 的每一步都被条件跳过，
**而 run 仍然全绿**。看绿灯时要意识到它可能什么都没部署，
真正的判据是线上 `build-info.json` 里的 sha，不是 CI 的颜色。

---

## 4. 提交约定

> **这一节是提交规范的唯一事实源**，别的文档只指过来、不另存一份。

- 分支：从 `cn_sora_blog` 切出来（默认工作分支）

### 4.1 格式

首行（subject）形如 **`type: 一句中文摘要`**，然后**空一行**，再写正文的 `- ` 列表：

```
fix: 留言板驳回理由一直显示未填写

- AI 裁决的说明文案在 flag 分支里丢了
- 兜底文案改成按原因码取
- 驳回理由改为必填
```

- **首行 ≤ 60 字符**（**中文按 1 个字算**，不是字节数），只写"改了什么"。
  它被 `git log --oneline`、GitHub 提交标题、`gh run list` 按截断显示 ——
  首行写成整段话的提交，事后 `--grep` 根本捞不出来。
- **多项改动一律写成正文的 `- ` 列表，不塞进首行**。首行只放能概括全部的那一句；
  日期戳（`20260922`）之类的考古锚点可以留，但那是正文的东西，不该把首行撑长。
- type 白名单：`feat`（新功能）/ `fix`（修缺陷）/ `refactor`（不改行为的重构）/
  `docs` / `test` / `chore`（杂务、依赖、构建配置）/ `perf` / `style` / `build` / `ci`。
  CI 里跑的就是这一串（`.githooks/commit-msg`），列表外的 type 会被拒。
- **不要加 `Co-Authored-By` / 共同作者署名**（维护者的明确要求）。工具（编辑器插件、
  AI 助手）默认往里加的那种署名，提交前删掉。
- **版本号同步（`?v=` bump）不写进提交信息**：版本号是部署细节，不是这次改动的内容。
- 改动的"为什么"写在**代码注释里**，不要只写在提交信息里：提交信息会随历史沉底，
  注释会跟着那行代码走。

两类反例：

```
✗ fix: 修复标题不居中、读数改 2×2、看板娘左移 20px、讨论区回复另起一行
      ↑ 四件事塞进首行：60 字符塞不下，而且 `--grep 看板娘` 一件都捞不出来
✗ fix: 讨论区回复标记另起一行
  - 回复标记从身份行首位挪到正文之前，不再隔断头像与昵称
      ↑ 首行与正文之间少了空行（写第二段时最容易漏）
```

### 4.2 机械闸门（跑一次就装上）

```bash
bash scripts/dev/install-hooks.sh     # = git config core.hooksPath .githooks，每台机器跑一次
```

装上后**每次 `git commit` 都会校验**上面那几条可机械判定的（首行长度、type 白名单、
首行后空行、`Co-Authored-By`），不合规直接拒绝提交。`merge` / `revert` / `fixup!` /
`squash!` 打头的提交自动豁免。

钩子文件（`.githooks/commit-msg`）会跟着 clone 走，但"去哪里找钩子"是 git 的本地配置，
**不会被 clone 带走** —— 所以新机器不跑这一行就什么都不会校验。CI 的 `check` job 对
本次 push 带来的每条提交跑**同一个文件**，那一层不依赖任何人的本地配置。

判不了的那些（"为什么"该写进注释、版本号不进提交信息）留在上面当人工纪律。


### 改代码时的几条硬约束

> ⚠️ **第 1、2 条是维护者那一侧的纪律，不是对你的要求**：他跑这套东西的那台机器
> **同时是生产服务器**（`cargo build --release` 与 `vite build` 的内存开销会把整机拖垮，
> 真发生过）。你 clone 到自己机器上，想构建就构建、想 `cargo clean` 就清，
> 不受这两条约束——但下面第 3 条对谁都成立。

1. **（维护者）本地不编译大产物**。`vite build` 和 `cargo build --release` 内存开销很大，
   低内存机器上会 OOM 甚至拖垮整机。他本地只跑 `cargo check`、`tsc`、`npm test`，构建交给 CI。
2. **（维护者）永远不要 `cargo clean`**（那台机器上 `target/release/` 里是线上正在跑的二进制）。
3. **动 git 前逐文件核对**，别用 `git add -A` / `git commit -a` —— 工作区里可能挂着
   别的分支/会话的改动。
4. **改协议/契约要三端同步**。SSE 帧协议（Python ↔ Rust ↔ 前端）、执行回执的字段名、
   提示词里的工具清单，这几处都是"改一处必须同步另一处"的地方，改完在注释里写清
   另一头在哪。
5. **迁移脚本要幂等**，并且把"这条约束为什么存在"写进头注 —— 迁移是一次性的，
   但它定下的语义（比如某个 CASCADE 行为）会跟项目一辈子。

---

## 5. 许可

本仓库以 **GPL-2.0** 分发（见 [LICENSE](LICENSE) 全文）。

**引入新依赖前先确认它的许可与本仓兼容**：

| 依赖的许可 | 能不能进本仓 |
|---|---|
| MIT / BSD / ISC / Zlib | ✅ 可以 |
| Apache-2.0 | ⚠️ 与 GPL-2.0 **不兼容**（专利条款）、与 GPL-3.0 兼容 —— 别直接并进本仓的源码树 |
| GPL-3.0-only | ❌ 不行 |
| 专有 / 未声明许可 | ❌ 不行 |

看板娘的渲染层是自研代码，基于 MIT 的 pixi.js + pixi-live2d-display
（见 [frontend/README.md](frontend/README.md)）。
**图片、字体、模型文件同样适用** —— "从某个 CDN 引一张图"也可能是在分发别人的作品。

还有一类**可以进构建产物、但不能进源码树**的：Live2D 的 Cubism Core 运行时是专有许可，
本仓不跟踪它，由 `npm run vendor:live2d` 在构建前从官方地址取（CI 会自动跑）。判据是
**这段字节是不是从本仓发出去的**——从官方源直取没问题，放进 git 就等于本仓在分发它。

**看板娘前端（`live2d-widgets/` + `live2d_model/`）的源码住在 `saudade-blog-agent` 仓**
（20261002 起；**没有并进本仓的源码树**，只是构建时按 pin 取产物）。那边以 MIT 分发
（`frontend/LICENSE`），与本仓的 GPL-2.0 兼容，这条链是通的。代价要记住：
**MIT 要求把版权与许可声明随分发一起带上**，所以那段的全文抄在本仓
[README.md](README.md) 的《许可》一节里——动那里之前先想清楚这一条。
其余第三方组件、版本与许可以及兼容性判据，统一见 [THIRD-PARTY.md](THIRD-PARTY.md)。

⚠️ **但那一半许可只覆盖代码**。同目录里的**美术资源**（`live2d_model/agent_2.*` 模型与贴图、
`lingyue-toggle.png` 面板图标，以及「泠月喵」形象设计本身）按 **CC BY-NC-SA 4.0** 分发
（agent 仓 `frontend/ASSETS-LICENSE.md`）：可自用、可改，**不可商用**，改作须同样协议。
**带 NC 的许可不是 OSI 开源许可**——那一部分属于"源码可用"。它与 GPL-2.0 的关系是
"同一介质上的聚合"（构建时取来一起打包、不是并进本仓源码树），所以不冲突；
但**上面那条兼容性结论只对代码那一半成立**，往本仓引进美术资源时不能拿它当通行证。

---

## 6. 已知缺口

诚实列出，免得你按文档走到一半撞墙：

- **`0000_base_schema.sql` 是生产库快照**——它逐字复刻线上 26 张表的 DDL，CI 每次 push
  都会用 `fresh_install.sh` 在一个空的 `mysql:8.0` 容器上从零建一遍（`deploy.yml` 的
  `Bootstrap MySQL schema` 那一步），所以这条路一直有人走。你的库上若报错多半是外键顺序，
  文件开头的 `FOREIGN_KEY_CHECKS=0` 就是为它准备的。
- **`scripts/migration/` 目录混着夹具与作者一次性脚本**（见 2.1 的两条提示）——
  没有按用途分目录，只能靠文件名前缀辨认。想改成分目录的话，先确认没人按路径引用它们。
- **六处路径的默认值写的是维护者那台机器的位置**（`healthcheck.sh` / `nightly_sandboxes.sh` /
  `deploy/*.sh` 四个脚本、`deploy.yml` 里那次 ssh、`src/routes/graph.rs` 的产物目录），
  但**每一处都能不改被跟踪的文件地覆盖**：`PROJECT_DIR`、`DEPLOY_REPO_DIR`（仓库 Variable）、
  `GRAPH_ARTIFACT_DIR`。**fork 时设这些就行**，没设才会落到那个默认值上——所以这不是
  "你得改源码"，只是默认值对你没意义。

---

## 7. 相关文件

| 文件 | 什么时候看它 |
|---|---|
| [ROADMAP.md](ROADMAP.md) | 现在在做什么、什么在等条件、什么**明确不做**（提提议前先看，尤其是那几张表） |
| [SECURITY.md](SECURITY.md) | 发现安全问题、或者想确认某件事算不算（里面有一份《已知且已经接受的取舍》） |
| [docs/security-boundary.md](docs/security-boundary.md) | 想弄清"谁信谁"：各条防线在哪、限额是多少、已知缺口 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 参与本仓的言行规范 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 引入新依赖前查许可 |
| [docs/deployment-and-ops.md](docs/deployment-and-ops.md) | 部署与运维（资源画像、服务管理、回滚） |
