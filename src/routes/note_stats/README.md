# 文章统计窗口

`GET /api/protected/stats/notes` 的 `dailyWindow` 与原 `daily` 使用同一份服务端本地统计日快照。
`start`、`end` 是最近30天的实际日期边界；`scope=rolling_window`。
`monthlySubtotals` 汇总这个窗口内各月的阅读、点赞、收藏和评论，并列明每段覆盖的起止日期。
它不是自然月全量，跨月、跨年及零值日期都保留；整月比较使用原有分期报表接口。

汇总复用已查询的日数据，不增加SQL请求。前端与Agent消费这些字段，不各自推算窗口或月份小计。
单元测试覆盖跨月、跨年、零值边界及序列化字段。
