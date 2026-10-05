# 路线图

这份文件管三件事：**现在在做什么**、**什么在等一个条件**、**什么明确不做**。
它不是承诺，是现状记录——条件变了就改这里，改的时候把日期写上。

---

## 现在（2026-10）

- **公开前的收尾**。这个仓正从"个人项目"转成"别人能看懂、能参与"的仓：
  治理文件补齐（本文、[SECURITY.md](SECURITY.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、
  issue/PR 模板）、文档里的私有坐标剥离、历史里不该带出去的内容清理。
- **稳定性优先**。**跑这个仓的那台机器就是生产服务器**（3.7GB 内存，nginx 直接服务
  `frontend/dist`，两个常驻服务 + 数据库都在上面）。任何改动先要保证不把它弄挂——
  提交前跑什么、什么不许在本地跑，见 [CONTRIBUTING.md](CONTRIBUTING.md) §3 与《改代码时的几条硬约束》。

---

## 待办（可行、还没做）

### 1. 让 CI 在 PR 上跑

现状：`deploy.yml` 只挂 `push: [cn_sora_blog]` 和 `workflow_dispatch`，
**PR 上什么都不跑**。PR 页面上"没有红灯"的含义是"没跑过"，不是"过了"。

这件事结构上是通的：`check` job（提交信息闸门、`cargo test` + `mysql:8.0` 服务容器、
`tsc --noEmit`、`npm test`、eslint）**一个 secret 都不需要**，包括从 fork 来的 PR 也能跑；
要做的只是给它加 `pull_request` 触发，并给 `build-and-deploy` 那半加事件守卫，
别让 PR 触发一次真部署（那半要用 SSH 与 R2 凭据）。

**为什么放着**：它改的是部署管线，而部署管线自身在 `paths-filter` 里（`infra`）——
改它就会真跑一次完整部署，得挑一个有部署窗口的时候做。

### 2. 一条指向不存在目录的路由

`src/routes/mod.rs` 里 `/christmas` 挂在 `/opt/memory_blog_rust/static/christmas` 上。
那个目录是**改名之前的布局**，现在不存在；本仓 `static/` 里只有 `OBC.bin`，
站内也没有任何地方链到 `/christmas`。所以它是一条**死路由**：不认识它的人不会踩到，
认识的人会拿到 404。

两条路选一条：**删掉这条路由**（倾向这个——没有消费方，也没有对应的页面），
或者把目录搬回本仓并改对路径。**谁来做**：改 `src/**` 会触发一次真部署，
所以等一次别的后端改动顺路带走，别为它单独部署一次。

---

## 搁置（方向认可，等一个可观测的信号）

写在下面这些**不是"以后有空再说"**——每一条都有一个能观测到的触发条件。
条件满足之前，维护者不会主动做它；满足之后欢迎直接开 issue 提这件事。

| 搁置的事 | 为什么现在不做 | 什么信号出现就做 |
|---|---|---|
| **把 `device-service` 也开源** | 它现在只以"单元模板 + 接口契约"的形式在 [iot/device-service/](iot/device-service/) 里；服务本体不在任何公开仓。要开放先得把里面写死的东西（topic 前缀、凭据从哪读、对部署方式的假设）通用化 | 有人真的想自己搭一套——开个 issue 说一声就算 |
| **`scripts/migration/` 按用途分目录**（夹具 / 一次性脚本 / 真正的迁移） | 现在靠文件名前缀辨认，[CONTRIBUTING §2.1](CONTRIBUTING.md) 里列了该跳过哪几类。分目录要先确认没有脚本按路径引用它们 | 这个目录再添第三类脚本，或者有人在 issue 里说被它绊过一次 |
| **沙箱套件跑完清理自己的临时目录** | `frontend/tests/*.test.py` 用 `tempfile.mkdtemp` 建了不删，跑多了会在 `/tmp` 积出空间。已知未修 | `/tmp` 因它涨到需要人工清一次 |
| **把脚本里的开发机路径彻底参数化** | `PROJECT_DIR` 环境变量已经能覆盖 `healthcheck.sh` / `nightly_sandboxes.sh` / `deploy/*.sh` 四个；CI 工作流里那一处仍写死 | 有人在别的机器上部署时真撞上 |

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
