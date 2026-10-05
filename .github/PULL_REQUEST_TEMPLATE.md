<!--
提交前请确认下面几件事。这份模板不是在收表格，它对应的是本仓真实踩过的失效：
每一条后面都写着"漏了会怎样"。
-->

## 这条 PR 做了什么

<!-- 一两句。写"为什么"，不写"改了哪几行"——diff 自己会说改了哪几行。 -->

## 跑过的

```bash
cd frontend && npm run fetch:widget && cd ..   # cargo test 的编译期前提，见下
cargo test
cd frontend
npx --no-install tsc --noEmit -p tsconfig.json
npm test
npm run lint
```

- [ ] `cargo test` —— 绿（**先跑过 `npm run fetch:widget`**：`src/routes/chat.rs` 有一条
      `include_str!` 是编译期读看板娘那个 `chat-stream.js` 的，没取回来会在这里报一个
      看不出前因后果的编译错）
- [ ] `tsc --noEmit` —— 干净
- [ ] `npm test` —— 绿（它**不包含** ESLint，两者是分开的两道门）
- [ ] `npm run lint` —— 干净（脚本自带 `--report-unused-disable-directives`：
      一条**多余的** `eslint-disable-next-line` 在这里判 error，而它会让 CI 红——
      **CI 红就意味着这次 push 什么都没部署**）
- [ ] 提交信息过了闸门（首行 ≤60 字符、type 在白名单里、首行后有空行、没有 `Co-Authored-By`）

> CI 在 push 到 `cn_sora_blog` 时会跑上面这些（`deploy.yml` 的 `check` job），
> 但**PR 上不跑**（见 ROADMAP 的待办）。所以这里"过了"是你自己跑出来的，不是机器给的。

## 需要同步的另一头

- [ ] 改了三端契约（SSE 帧协议 / Python ↔ Rust 的字段名 / 提示词里的工具清单）——
      **另一侧也改了**，并在下面说明怎么核对的。这几处都是"改一处必须同步另一处"的地方
- [ ] 动了看板娘前端（`live2d-widgets/`、`live2d_model/`）—— 那些文件的**源码不在本仓**，
      得先去 [saudade-blog-agent](https://github.com/BigLeopardCat/saudade-blog-agent) 改，
      再回来把 `frontend/widget.lock.json` 里的 pin 换掉。
      **忘了换 pin，改动永远不会上线，而且没有任何东西会变红**
- [ ] 加了迁移脚本 —— 它是**幂等**的，并且想清楚了 `fresh_install.sh` 的日期规则
      （快照日当天的会跳过）与 `apply_despite_snapshot()` 名单要不要动

## 影响面

- [ ] 我**没有**在本地跑 `vite build` / `cargo build --release`（这台机器同时是生产机）
- [ ] 我**没有**用 `git add -A` / `git commit -a`（工作区里可能挂着别的会话的改动）
- [ ] 若改了 `src/**` 或前端：我知道这次 push 会触发一次**真的部署**（按提交号打包上传、
      落地后重启服务），而不是只跑 CI

## 需要 reviewer 特别注意的

<!--
例如：这条改动碰了某个既成事实的前提；这条只在某个开关打开时才生效而我这边开不了；
我改了一处契约文本，但不确定"这一格是否还装得下原来的病"。
写"我不知道"比写"应该没问题"有用得多。
-->

## 关联

Closes #
