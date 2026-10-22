# 后台审核读取

以下接口均位于管理员鉴权路由；身份与角色由后端核验。

## 分页记录

- `GET /api/protect/board?page=1&page_size=5`：河灯留言。
- `GET /api/protect/comments?page=1&page_size=5`：文章评论。

传入 `page_size` 时，响应为 `{code,data,total}`；`total` 是相同筛选条件的总数，
`data` 仅包含本页，不能将本页条数当成总数。排序为创建时间、编号双重倒序。
每页大小限制为 1–200；页码与偏移溢出返回错误。

共同筛选：`id`、`status=pending|passed|rejected`、`q`。
`q` 匹配正文与发表账号；留言还匹配自由填写的留名。匹配不区分大小写，通配符字符按字面处理。
留言另支持 `ai_result=pass|flag|reject|none`、`cat`、`order=asc|desc`；
评论另支持 `note_id`。不支持的审核状态或 AI 判定返回参数错误，不悄悄放宽筛选。
最终审核状态与 AI 判定是独立维度。评论后台保留软删除记录，并通过 `isDeleted` 标识。

不传 `page_size` 时保留原有响应形状，不含 `total`：留言返回全量，评论保留 500 条上限。
这是既有前端与旧执行图的迁移接口；新的 Agent 读取始终显式分页。

## 审核汇总

`GET /api/protected/moderation/summary` 只聚合 `src=board` 的河灯留言，不读取正文。
`data` 包含 `total`、`pending`、`passed`、`rejected`、`aiPassed`、`aiFlagged`、
`aiRejected`、`aiUnreviewed`。两组分布各自与总数对应，不能把 AI 通过当成人工最终通过。
数据库失败、未知状态返回错误，不能转成零计数。
