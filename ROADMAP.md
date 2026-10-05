# 路线图

这份文件管三件事：**现在在做什么**、**什么在等一个条件**、**什么明确不做**。
它不是承诺，是现状记录——条件变了就改这里，改的时候把日期写上。

---

## 现在（2026-10）

- **已经公开，收尾还在继续**。这个仓现在是 **public 仓库**：治理文件（本文、
  [SECURITY.md](SECURITY.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、issue/PR 模板）、
  文档里的私有坐标剥离、历史里不该带出去的内容清理，都已完成。剩下的是发现一处修一处。
- **稳定性优先**。**跑这个仓的那台机器就是生产服务器**（3.7GB 内存，nginx 直接服务
  `frontend/dist`，两个常驻服务 + 数据库都在上面）。任何改动先要保证不把它弄挂——
  **注意：这条约束是对维护者的，不是对你的**，见
  [CONTRIBUTING.md](CONTRIBUTING.md) 的《改代码时的几条硬约束》。

---

## 刚做完（20261006）

- **CI 在 PR 上也跑 `check` 了**。此前 `deploy.yml` 只挂 `push: [cn_sora_blog]` 与手动触发，
  **PR 上什么都不跑**——PR 页面"没有红灯"的含义是"没跑过"。现在加了 `pull_request` 触发：
  `check`（提交信息闸门、`cargo test` + `mysql:8.0` 服务容器、`tsc --noEmit`、`npm test`、eslint）
  **一个 secret 都不需要**，所以**连 fork 来的 PR 也有完整反馈**；部署那一半要 R2 凭据与
  SSH 私钥，在 PR 上**恒不触发**（`check-changes` 的 `deploy` 输出在 PR 上恒为 false，
  `build-and-deploy` 的每一步本来就带 `if`，于是它自然空转）。
- **删掉了 `/christmas` 死路由**：它把一个静态目录服务挂在**本机并不存在的绝对路径**上，
  而它要服务的那份页面（`static/christmas/`：一个圣诞主题的静态页，带音乐与雪花脚本）
  早在 20260418 就从仓库里删掉了。全仓零引用，删掉即净。页面本体在 git 历史里还找得回来
  （删除它的那个提交的上一个版本），哪年圣诞想要再说。
- **沙箱套件不再往 `/tmp` 里积目录**（搁置表里那条的触发信号——"/tmp 因它涨到需要人工清一次"
  ——出现了）。`frontend/tests/` 下那批套件用 `mkdtemp` 建临时目录、此前**跑完基本不删**，
  两侧合计在 `/tmp` 积到 **4.5G**（占整个 `/tmp` 的八成；最大一族 141 个目录 / 2.5G）。
  现在两个运行器（`scripts/nightly_sandboxes.sh` 与 `frontend/tests/run-suites.mjs`）给每个
  套件一个**专属 `TMPDIR`**：通过就删、失败**留下**并把路径写进日志（失败现场是排障材料）；
  隔不到的那些（手跑单个套件、被 kill 的轮次）由 `scripts/prune_sandbox_tmp.py` 在夜跑末尾
  收走——它的前缀是**从套件源码现场推出来的**，不是手写名单（手写的版本漏了六族、700M+，
  而"漏一族"永远不会有人报错）。**没有改 61 个套件文件的源码**；残余是手跑的那次仍落在
  `/tmp`，等当晚的清扫。

---

## 待办

（当前没有排上队的。上面两条做完之后，手上没有"可行但还没做"的项——新的一律先进 issue。）

---

## 搁置（方向认可，等一个可观测的信号）

写在下面这些**不是"以后有空再说"**——每一条都有一个能观测到的触发条件。
条件满足之前，维护者不会主动做它；满足之后欢迎直接开 issue 提这件事。

| 搁置的事 | 为什么现在不做 | 什么信号出现就做 |
|---|---|---|
| **把 `device-service` 也开源** | 它现在只以"单元模板 + 接口契约"的形式在 [iot/device-service/](iot/device-service/) 里；服务本体不在任何公开仓。要开放先得把里面写死的东西（topic 前缀、凭据从哪读、对部署方式的假设）通用化 | 有人真的想自己搭一套——开个 issue 说一声就算 |
| **`scripts/migration/` 按用途分目录**（夹具 / 一次性脚本 / 真正的迁移） | 现在靠文件名前缀辨认，[CONTRIBUTING §2.1](CONTRIBUTING.md) 里列了该跳过哪几类。分目录要先确认没有脚本按路径引用它们 | 这个目录再添第三类脚本，或者有人在 issue 里说被它绊过一次 |
| **把脚本里的开发机路径彻底参数化** | 现在**六处**的默认值写的是开发者那台机器的位置（`healthcheck.sh` / `nightly_sandboxes.sh` / `deploy/*.sh` 四个脚本、`deploy.yml` 里那次 ssh、`src/routes/graph.rs` 的产物目录），但**每一处都能不改被跟踪的文件地覆盖**——`PROJECT_DIR` / `DEPLOY_REPO_DIR`（仓库 Variable）/ `GRAPH_ARTIFACT_DIR`，所以 fork 的人设一下就行。真正更好的改法是让脚本从**自身位置**推出仓根（`$(dirname "$0")/../..`），那样连设都不用设 | 有人在别的机器上部署时真撞上 |

---

## 明确不做

这几条是**想清楚了不做**，不是还没轮到。别为它们开 PR；若有新证据（比如某条的前提变了）请开 issue 说明。

- **不给 `/api/protect/download` 下的文件加鉴权**。这是知情后的取舍，不是遗漏——
  理由与"什么情况下算新证据"写在 [SECURITY.md](SECURITY.md) 的《已知且已经接受的取舍》。
- **不恢复"把 `dist` 逐文件上传 R2"那一步**。它 20260924 被删掉：没有消费方
  （nginx 读的是本机 `frontend/dist`），内容与部署包完全重复，而每次部署约 5000 次 PUT——
  一天几次部署就超过 R2 免费档的写入上限。
- **不在开发机上构建大产物**（`vite build` / `cargo build --release`）。这台机器同时是
  生产机，构建会 OOM 甚至把整机拖垮；构建一律交给 CI。本地只跑 `cargo check`、`tsc`、`npm test`。
  同样地：**永不 `cargo clean`**（`target/release/` 里是线上正在跑的那个二进制）。
- **不把看板娘前端并进本仓的源码树**。它的源码住在
  [saudade-blog-agent](https://github.com/BigLeopardCat/saudade-blog-agent)，本仓只按
  `frontend/widget.lock.json` 里的 pin 在构建时取回。理由见 [CONTRIBUTING.md](CONTRIBUTING.md) §5（许可）。

---

## 怎么参与

先读 [CONTRIBUTING.md](CONTRIBUTING.md)。想找活干看 issue 上的标签：

| 标签 | 含义 |
|---|---|
| `good first issue` | 边界清楚、不需要跑起整套系统 |
| `help wanted` | 明确需要外部视角 |
| `future` | **方向认可、条件未到**——触发条件写在 issue 里，issue 保持开着 |
| `icebox` | 更远，连触发条件都还没有 |
| `needs-triage` | 还没分类 |
| `wontfix` | 明确不做（关闭时用 `not planned`） |

`future` / `icebox` / `wontfix` 的区别值得记一下：**不是"没在写"就都一样**——
`future` 是迟早要做、等一个信号；`icebox` 是方向认可但没有信号可等；
`wontfix` 是想清楚了不做。三者在 issue 列表上长得一样，只能靠标签区分。
