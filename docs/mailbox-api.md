# 本人信箱查询

`GET /api/protected/messages` 需要登录，所有收件查询均限定当前用户为收件人。

- 无参数：返回最近 100 封收信与最近 100 封发信。
- `unreadOnly=true`：收件部分返回最近 100 封未读信，包括默认窗口之外的旧信。
- `ids=1,2`：收件部分查询 1 到 100 个正整数编号；不存在或不属于本人收件箱的编号不返回。
- `ids` 与 `unreadOnly=true` 不能同时使用。查询不修改已读状态。

响应继续包含 `inbox`、`outbox`、`unread`。`unread` 统计整个收件箱，不受当前筛选和窗口限制。
新增 `inboxComplete` 表示当前筛选的收件结果未被 100 封上限截断，不能将截断列表当作全量。

`POST /api/protected/messages/read` 的现有协议保持兼容。需要固定确认范围的调用方应发送
具体编号与 `all=false`，写后按同一批编号重新查询并逐项核对，不能只看全局未读数是否下降。

实现位于 `src/routes/profile/mailbox.rs`。模块的数据库契约测试在 `TEST_PG_URL` 配置时
使用事务创建夹具并回滚，验证窗口外旧信、全局未读数与收件人隔离。
