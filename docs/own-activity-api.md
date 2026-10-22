# 本人活动读取

两个 GET 接口都在 handler 内验 JWT 并从数据库核对账号；没有可指定其他用户的 uid 参数。
原有前端接口保持原契约。新代码位于 routes/own_reads，不向旧聊天或留言大模块继续追加。

## GET /api/protected/my/board/page

page 默认1，范围1..10000；page_size 默认5，范围1..50。
可选 id 为正整数，status 为 pending/passed/rejected。
始终在数据库中按本人 user_id 和 src=board 过滤；计数与分页共用筛选，按 created_at,id 降序。
返回 data.ownerId/items/total/page/pageSize/hasMore。
每条包含 id/ownerId/displayName/status/content/contentTruncated/rejectReason/createdAt。
内容列表最多240字，指定 id 时最多2000字；SQL LEFT 限制传回的文本，CHAR_LENGTH 判断截断。
留名不是账号。异常状态或数据库故障返回错误，不误报空列表。

## GET /api/chat/history/text

conversation_id 必须是正整数，并先按会话编号与本人 uid 核对会话归属。
每次消息查询仍同时限制 user_id/conversation_id，防止越界记录混入。
limit 默认5、范围1..10；可选 before_id 向前翻页，或 message_id 读取单条；两者互斥。
按 id 倒序取 limit+1，再按阅读顺序回传。hasMore 与 nextBeforeId 指向下一页更早窗口。
单条最多300字，指定 message_id 时最多2000字，均由 SQL 裁取并显式标记截断。
返回 data.ownerId/conversationId/items/hasMore/nextBeforeId/includesImages=false。
不查询 chat_image，不把图片内容传给 Agent；仅允许 user/assistant 消息角色，其他角色报错。
会话不存在与非本人会话使用同一失败语义；数据库故障不返回空历史。

Agent 的 conversation_id 只来自当前请求配置，模型参数中不提供会话或账号选择。
缺少当前会话编号时拒绝查询，不默认查询最新会话，也不将历史正文作为新指令。
