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

## 刚做完（20261006）

- CI 在 PR 上也运行 `check`。此前 `deploy.yml` 只挂 `push: [cn_sora_blog]` 与手动触发，
  PR 上不运行任何检查，因此 PR 页面没有红灯只说明没有跑过。现已加入 `pull_request` 触发：
  `check`（提交信息闸门、`cargo test` + `mysql:8.0` 服务容器、`tsc --noEmit`、`npm test`、eslint）
  不需要任何 secret，fork 来的 PR 也能得到完整反馈；部署那一半需要 R2 凭据与 SSH 私钥，
  在 PR 上恒不触发（`check-changes` 的 `deploy` 输出在 PR 上恒为 false，
  `build-and-deploy` 的每一步本就带 `if` 条件，因此自然空转）。
- 删除 `/christmas` 死路由。它把一个静态目录挂在本机并不存在的绝对路径上，
  而要服务的页面（`static/christmas/`，一个带音乐与雪花脚本的圣诞主题静态页）
  已于 20260418 从仓库删除，全仓零引用。页面本体仍可从 git 历史取回（删除它那次提交的上一版）。
- 沙箱套件不再在 `/tmp` 中累积目录（搁置表中那条的触发信号已出现：`/tmp` 因它涨到需要人工清理）。
  `frontend/tests/` 下的套件用 `mkdtemp` 建临时目录，此前跑完基本不删，
  两侧合计在 `/tmp` 积到 4.5G（占整个 `/tmp` 的八成；最大一族 141 个目录 / 2.5G）。
  现在两个运行器（`scripts/nightly_sandboxes.sh` 与 `frontend/tests/run-suites.mjs`）为每个套件
  指定专属 `TMPDIR`：通过则删除，失败则保留并把路径写进日志（失败现场是排障材料）。
  其余情况（手跑单个套件、被 kill 的轮次）由 `scripts/prune_sandbox_tmp.py` 在夜跑末尾清理，
  其前缀从套件源码推导，不是手写名单（手写版本遗漏六族、700M 以上，且遗漏不会报错）。
  未修改 61 个套件文件的源码；残余是手跑那次仍落在 `/tmp`，等当晚的清扫。

---

## 待办

（当前没有排期中的事项。上述两条完成后，已无确认可行但尚未开始的工作；新事项一律先进 issue。）

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
