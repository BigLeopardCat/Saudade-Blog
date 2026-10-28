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

## 小型读取视图

`GET /api/protected/messages/recent?folder=inbox&limit=5` 返回近期摘要：

- `folder` 可选 `inbox` 或 `outbox`，默认收件箱。
- `limit` 默认 5，只接受 1 到 10；超出范围返回错误。
- 响应为 `folder`、`items`、`hasMore`。条目包括编号、双方编号、对方名字、标题、时间和已读状态。
- 正文列不参与数据库查询，也不进入响应。`hasMore=true` 时不能将窗口解释为整个信箱。

`GET /api/protected/messages/{id}` 返回单封正文，仅收发双方可读取。不存在与不属于本人
使用相同错误出口。列表及详情均不修改已读状态。

`GET /api/protected/notifications/summary` 是独立计数聚合；读取内容由列表或详情接口承担。
通知数或信件数查询失败时返回失败，不能以零未读代替未知结果。

## 本人删除

- `DELETE /api/protected/notifications/{id}` 从当前账号的公告和通知列表移除记录，
  不撤回全站公告，也不影响其他账号。
- `DELETE /api/protected/messages/{id}?folder=inbox|outbox` 只移除本人在指定信箱中的记录，
  默认 `inbox`。收发双方独立控制自己的可见性；发件人删除不撤回对方的收信。
- 两个接口均从登录凭据取账号，不接受用户编号；重复删除幂等，返回最新未读汇总。
- 删除不等同于已读。列表、未读计数、近期摘要及详情都使用同一可见性条件，
  已删除内容也不会再通过 Agent 的本人读取接口返回。
- PostgreSQL 迁移 `0020_personal_message_deletion.sql` 新增可空删除时间列。
  升级时先应用迁移，再部署服务；现有数据无需回填，旧服务仍兼容新增列。

## 公告弹窗读取

`GET /api/protected/notifications/announcement` 返回当前账号最新公告的通知对象，
没有公告、最新公告已读或已被本人删除时返回 `null`。服务器先定位最新公告再检查状态，
因此删除最新公告不会把更旧的未读公告重新弹出。弹窗不再轮询包含所有正文的通知列表。

个人删除测试覆盖外部账号、收发双方独立删除、重复删除、自己给自己发信、可见性与
公告屏障；配置 `TEST_PG_URL` 时在事务内创建随机夹具并回滚。
