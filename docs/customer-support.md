# 博客客服

访客在 `/support` 查看公开常见问题。登录后可提问或直接提交工单，从「我的咨询与工单」查看历次回复。咨询可转为工单，沿用原编号和历史。管理员在 `/dashboard/support` 按状态筛选并回复，已解决的记录可以重新打开。

## 接口

公开知识条目来自 `GET /api/public/support/topics`。每个条目含稳定的 `id`、问题、答复和站内路径。其他接口需要博客登录身份。管理员队列走后台的实时角色校验，普通账号只能访问自己提交的记录。

| 操作 | 请求 |
| --- | --- |
| 列出我的记录 | `GET /api/protected/support/cases` |
| 发起咨询或工单 | `POST /api/protected/support/cases` |
| 读取一条记录及时间线 | `GET /api/protected/support/cases/{id}` |
| 回复、转工单、解决或重开 | `POST /api/protected/support/cases/{id}/events` |
| 客服队列、详情与处理 | 在上述列表、详情与事件路径中将 `/protected/support/` 换为 `/protected/admin/support/` |

创建请求包含 `kind`（`question` 或 `ticket`）、`subject`（1–120 字）、`body`（1–4000 字）和客户端生成的 UUID `requestId`。身份与发送方标签由服务端确定。列表可按 `status` 筛选，以编号倒序返回，详情页中的事件按时间顺序展示。两者每页最多 30 条，用返回的 `nextBefore` 作为下一次请求的 `before` 读取更早的数据。

追加事件时提供最新的 `version`、新的 `requestId` 和 `action`。只有 `reply` 携带非空正文。客户回复后进入 `waiting_staff`，客服回复后进入 `waiting_user`。活动咨询可执行 `escalate` 转为待客服处理的工单。活动记录可 `resolve`，已解决记录需先 `reopen` 才能续写。

重试同一次操作沿用原请求编号与请求体。成功回包丢失时重试可取回原记录。并发更新使用数据库行锁和版本校验，旧版本或重复编号与原意图冲突返回 HTTP 409。事件和新状态一起提交。其他用户的私有编号返回 404。后台访问要求当前账号是管理员或超级管理员。

## 发布与验证

已有站点先以表所有者在 `public` schema 执行 [0040 客服迁移](../scripts/migration/pg/0040_customer_support.sql)，再发布后端和前端。新安装的数据库按编号清单自动初始化。应用回退时保留客服数据。每个账号每分钟最多提交 30 次写请求，超限返回 HTTP 429。

在已初始化的独立 PostgreSQL 中配置 `TEST_PG_URL` 与测试专用 `JWT_SECRET`，执行 `cargo test --locked --test customer_support_pg`。该测试使用实际路由和三个合成身份，覆盖咨询、并发重复提交、转工单、人工回复、状态冲突、关闭重开和私有记录隔离。

## 启用泠月喵客服

看板娘的「问题反馈」进入客服模式。Lunima 负责从公开帮助、公开文章搜索查找答案，信息不足时请求补充，敏感或超出范围的问题沿用原对话转后台工单。客服使用站内规则和公开数据，私有对话不会离开博客部署环境。后台接手、用户转人工或提交更新后，数据库拒绝旧轮次结果。

已有站点按顺序执行 0040 与 [0041 客服会话迁移](../scripts/migration/pg/0041_lunima_support_turns.sql)，再发布应用。已有站点启用新进程时停止旧版首次咨询脚本。

为助手单独创建一个仅可登录的 PostgreSQL 角色，例如 `support_worker`，通过站点现有的私有凭据管理方式配置登录。以表所有者授予以下权限。

```sql
GRANT USAGE ON SCHEMA public TO support_worker;
GRANT SELECT ON public.support_pending_turn TO support_worker;
GRANT EXECUTE ON FUNCTION public.support_publish_assistant(integer, integer, integer, text, boolean) TO support_worker;
```

在 Python 3.11+ 的专用虚拟环境中安装与服务器架构匹配的 Lunima 0.2.0 wheel 与 psycopg 3。`LUNIMA_WHEEL` 指向已取得的本地 wheel 文件。为服务配置 `SUPPORT_WORKER_DATABASE_URL`（上述角色的 DSN）、`SUPPORT_RUNTIME_DB`（该服务独占、可持久写入的 SQLite 路径）和 `SUPPORT_BLOG_URL`（可达的博客后端，默认 `http://127.0.0.1:3000`）。

```sh
python -m pip install "$LUNIMA_WHEEL" 'psycopg[binary]>=3.2,<4'
python tools/support-worker/agent_worker.py
```

将 `agent_worker.py` 与安装好 wheel 的虚拟环境一并放入同一个固定发布目录，按 [systemd 模板](../deploy/systemd/saudade-support.service.template)配置。运行时数据库可设为 `/var/lib/saudade-support/runtime.sqlite`。同一运行时文件保持一个所有者进程。`SUPPORT_WORKERS` 默认 4，支持 1–16。从低值开始，按站内接口和数据库压测调整。首次验收可附加 `--once` 处理一批。停止助手期间博客仍可接收并人工处理工单，重启后从待处理轮次继续。

用 `python -m unittest discover -s tools/support-worker -v` 可在临时 SQLite 上复验匹配、歧义转人工、私有正文和跨账号历史隔离，以及重启后复用同一任务。
