# 路线图

本文件记录三件事：现在在做什么、什么在等条件、什么明确不做。
它是现状记录，不是承诺；条件变化时更新本文件，并写上日期。

---

## 现在（2026-10）

- 仓库已公开，收尾仍在进行。治理文件（本文件、[SECURITY.md](SECURITY.md)、
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、issue 与 PR 模板）已就位，文档中的私有坐标已剥离，
  历史中不宜公开的内容已清理。后续工作是发现一处修一处。
- 稳定性优先。运行本仓的机器同时是生产服务器（3.7GB 内存，nginx 直接服务
  `frontend/dist`，两个常驻服务与数据库都在其上）。任何改动都不得影响它的可用性。
  这条约束针对维护者，不针对贡献者，见
  [CONTRIBUTING.md](CONTRIBUTING.md) 的《改代码时的几条硬约束》。

---

## 待办

| 待办的事 | 现在什么状态 | 为什么还没做 |
|---|---|---|
| **把 `deploy/install.sh` 与 `deploy/docker/*` 从 MySQL 换成 PostgreSQL** | **陈旧，暂时不可用**（20261018 切库时有意留下）：`src/` 与 `Cargo.toml` 已经只认 `postgres://`，而这两条安装路径仍会建一个 MySQL 库并写 `DATABASE_URL=mysql://…` ⇒ 装完起不来 | 它们是一键安装/容器路径，不在生产链路上（生产走 CI + `scripts/deploy/deploy_from_r2.sh`）。转换要处理 `sudo -u postgres` 的建号/建库、`pg_hba` 与口令文件那一套，改动面 30+ 处，值得单独一批做、单独验 |
| **`scripts/migration/pg/0000_schema.sql` 的生成器断粮** | 那份文件由 `mysql2pg.py` 从**活 MySQL** 生成；切流后 MySQL 不再演进 ⇒ 重生成的路作废。新的结构变更必须直接写成 PG 迁移（`0001_*` / `0002_*` 那样的编号文件） | 不是坏事，只是口径变了：结构从此以 `0000_schema.sql` 为真相源。要不要顺手把"从实体生成 PG DDL"补回来，等下一次真要改结构时再定 |
| **`scripts/migration/*.sql`（MySQL 那一套）整体退役** | 冻结在历史状态，不再参与建库、也不该在 PG 上跑。目录里混着夹具与一次性脚本 | 与上一条同源。要不要归档进子目录，见下面《搁置》里那条 |

---

## 搁置（方向认可，等一个可观测的信号）

下列各项都不是泛泛的待办，每一项都有可观测的触发条件。
条件满足前维护者不会主动推进；满足后欢迎直接开 issue 提出。

| 搁置的事 | 为什么现在不做 | 什么信号出现就做 |
|---|---|---|
| **把 `device-service` 也开源** | 它现在只以"单元模板 + 接口契约"的形式在 [iot/device-service/](iot/device-service/) 里；服务本体不在任何公开仓。开放之前先要把其中写死的东西（topic 前缀、凭据来源、对部署方式的假设）通用化 | 有人确实想自己搭一套，开 issue 说明即可 |
| **`scripts/migration/` 按用途分目录**（夹具 / 一次性脚本 / 真正的迁移） | 现在靠文件名前缀辨认，[CONTRIBUTING §2.1](CONTRIBUTING.md) 里列了该跳过哪几类。分目录要先确认没有脚本按路径引用它们 | 这个目录再添第三类脚本，或有人在 issue 里报告被它绊过一次 |
| **把脚本里的开发机路径彻底参数化** | 现在**六处**的默认值写的是开发者那台机器的位置（`healthcheck.sh` / `nightly_sandboxes.sh` / `deploy/*.sh` 四个脚本、`deploy.yml` 里那次 ssh、`src/routes/graph.rs` 的产物目录），但每一处都能在不改被跟踪文件的前提下覆盖：`PROJECT_DIR` / `DEPLOY_REPO_DIR`（仓库 Variable）/ `GRAPH_ARTIFACT_DIR`，fork 的人设一下即可。更好的改法是让脚本从自身位置推出仓根（`$(dirname "$0")/../..`），那样连设都不用设 | 有人在别的机器上部署时真撞上 |

---

## 明确不做

下列各项是已经决定不做，不是尚未排期。 请勿为此开 PR；若有新证据（例如某项的前提已变化），
请开 issue 说明。

- 不给 `/api/protect/download` 下的文件加鉴权。这是知情后作出的取舍，不是遗漏；
  理由与判定新证据的条件写在 [SECURITY.md](SECURITY.md) 的《已知且已经接受的取舍》。
- 不恢复"把 `dist` 逐文件上传 R2"那一步。它于 20260924 删除：没有消费方
  （nginx 读的是本机 `frontend/dist`），内容与部署包完全重复，而每次部署约 5000 次 PUT，
  一天几次部署就超过 R2 免费档的写入上限。
- 不在开发机上构建大产物（`vite build` / `cargo build --release`）。这台机器同时是
  生产机，构建会 OOM 甚至把整机拖垮；构建一律交给 CI。本地只跑 `cargo check`、`tsc`、`npm test`。
  同样地：永不 `cargo clean`（`target/release/` 里是线上正在跑的那个二进制）。
- 不把看板娘前端并进本仓的源码树。它的源码住在
  [saudade-blog-agent](https://github.com/BigLeopardCat/saudade-blog-agent)，本仓只按
  `frontend/widget.lock.json` 里的 pin 在构建时取回。理由见 [CONTRIBUTING.md](CONTRIBUTING.md) §5（许可）。

---

## 怎么参与

先读 [CONTRIBUTING.md](CONTRIBUTING.md)。想找活干看 issue 上的标签：

| 标签 | 含义 |
|---|---|
| `good first issue` | 边界清楚、不需要跑起整套系统 |
| `help wanted` | 明确需要外部视角 |
| `future` | 方向认可、条件未到；触发条件写在 issue 里，issue 保持开着 |
| `icebox` | 更远，连触发条件都还没有 |
| `needs-triage` | 还没分类 |
| `wontfix` | 明确不做（关闭时用 `not planned`） |

三者的区别不要合并看待：

- `future`：迟早要做，等一个信号；
- `icebox`：方向认可，但没有信号可等；
- `wontfix`：已决定不做。

三者在 issue 列表上外观相同，只能靠标签区分。
