# 管理员目录读取

受既有后台管理员守卫保护。默认 page=1、page_size=5；page 范围 1..10000，page_size 范围 1..50。
响应使用 ApiResponsePage：data 是本页数组，total 是匹配总数。数据库失败返回错误，不返回空列表。
计数和分页使用相同筛选，排序包含唯一编号；两次查询不构成跨请求快照。

## GET /api/protected/articles

可选参数：正整数 id、keyword、category。文本参数不得全为空白，最多 100 字。
包含独立草稿、私密和公开文章；排除 draft_of 非空的编辑修改稿。
keyword 是按连续字串匹配标题、正文或标签名的 PostgreSQL ILIKE，百分号、下划线和反斜线按字面转义。
这不是旧搜索接口的分词、排序和语义搜索。category 按名称精确匹配，不存在或重名返回错误。

返回 id/title/status/isPublic/isTop/categoryId/categoryName/createdAt/updatedAt/tags。
status 和 isPublic 分别保留数据库事实，NULL 不补成公开状态；查询不选择文章正文。
标签按 seq 排序，保留 id/level/name，一级和二级编号属于不同命名空间。
分类与标签查询失败不会静默返回无分类、无标签的记录。按 created_at,id 降序。

## GET /api/protected/accounts

可选参数：正整数 id、完整 username。username 不按昵称或模糊匹配。
在数据库计数与分页前从 authz::KNOWN_ROLES 和 is_listable_role 推导可见角色，排除超级管理员及未知角色。
返回 id/username/role/frozen/quotaUsed/quotaLimit/muted/mutedUntil，按 id 升序。
账号查询只投影必要列，不选择密码、令牌版本、邮箱或其他登录凭据。
冻结、禁言和额度上限沿用既有业务含义，不新增变更能力。

## 兼容和验收

旧编辑器的 notes/list、notes/search 以及 temp-users 裸数组接口保留原有契约；本接口是有界只读目录。
共享 pagination 模块供工作队列与目录使用。目录的生产数据库验证仅运行 catalog 测试，所有夹具在事务内回滚。
Agent 每页最多 10 条，不使用本页位置作为写入标识；元数据或标签节选显式标记截断。
