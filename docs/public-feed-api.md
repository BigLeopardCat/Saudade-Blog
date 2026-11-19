# 公开首页文章流

React 首页通过 `GET /api/public/notes/feed?limit=6&cursor=…` 加载文章卡片。

| 项目 | 契约 |
| --- | --- |
| `limit` | 1–50。 |
| `cursor` | 传上页的 `nextCursor`，缺省时从头读取。非法游标返回 400。 |
| 响应 | `data.items` 为卡片摘要，`data.nextCursor` 可为空，空值表示已到末尾。 |
| 查询失败 | 返回 503，可保留已加载页面后重试。 |

游标按 `(created_at DESC, id DESC)` 排序。宿主只投影卡片摘要，额外读取一条记录判断后续页。
此入口使用游标分页，原页码接口仍服务其他消费方。发布涉及索引时按[数据库运维](deployment-and-ops.md#postgresql)应用 `0035_note_feed_order.sql` 并核对索引契约。
