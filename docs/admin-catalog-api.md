# 管理员目录读取

受既有后台管理员守卫保护。默认 page=1、page_size=5；page 范围 1..10000，page_size 范围 1..50。
响应使用 ApiResponsePage：data 是本页数组，total 是匹配总数。数据库失败返回错误，不返回空列表。
计数和分页使用相同筛选，排序包含唯一编号；两次查询不构成跨请求快照。

## GET /api/protected/articles

可选参数：正整数 id、keyword、category、view=summary|full。文本参数不得全为空白，最多 100 字。
包含独立草稿、私密和公开文章；排除 draft_of 非空的编辑修改稿。
keyword 是按连续字串匹配标题、正文或标签名的 PostgreSQL ILIKE，百分号、下划线和反斜线按字面转义。
category 按名称精确匹配，不存在或重名返回错误。

`view=summary` 返回 id/title/status/isPublic/isTop/categoryId/categoryName，不加载标签详情或返回时间字段。
`view=full` 或省略 view 时额外返回 createdAt/updatedAt/tags/tagsTruncated。
缺失的详细字段表示没有读取，不表示没有标签；createdAt 是记录创建时间，不是首次发布时间。
status 和 isPublic 分别保留数据库事实，NULL 不补成公开状态；查询不选择文章正文。
标签按 seq 排序，保留 id/level/name，一级和二级编号属于不同命名空间。
分类与标签查询失败不会静默返回无分类、无标签的记录。按 created_at,id 降序。

## GET /api/protected/accounts

可选参数：正整数 id、完整 username、query；多个条件取交集。
username 按原值精确匹配登录名，最多 255 字符；不把昵称当作登录名。
query 最多 100 字符，在登录名和昵称上作不区分大小写的连续字串检索，百分号、下划线和反斜杠按字面匹配。
拒绝空白检索词、无效编号与未支持的参数。
在数据库计数与分页前从 authz::KNOWN_ROLES 和 is_listable_role 推导可见角色，排除超级管理员及未知角色。
返回 id/username/nickname/role/frozen/quotaUsed/quotaLimit/muted/mutedUntil，按 id 升序。
账号查询只投影必要列，不选择密码、令牌版本、邮箱或其他登录凭据。
目录仅提供只读候选，不自动选择写入目标。账号变更使用[账号管理接口](account-actions.md)的明确身份、版本核验、授权和事务。

## 兼容和验收

编辑器的 notes/list、notes/search 与 temp-users 裸数组接口独立维护；本页接口提供有界只读目录。
共享 pagination 模块供工作队列与目录使用。PostgreSQL 集成测试使用显式 TEST_PG_URL 和可丢弃数据库，夹具在事务内回滚。
Agent 文章目录默认每页 25 条、最多 50 条，不使用本页位置作为写入标识；元数据或标签节选显式标记截断。
