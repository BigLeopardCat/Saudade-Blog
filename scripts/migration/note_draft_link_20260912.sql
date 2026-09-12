USE memory_blog;
-- 20260912c 编辑修改稿：note 表补 1 列，把「正在编辑的已发布文章」的自动保存落到一行独立修改稿上。
-- 背景：编辑器原来的自动保存只写 localStorage（note_draft_{id}），有两个洞——① 保存成功后
--       removeItem 与 navigate 触发的卸载落盘互相抢，草稿清不掉，二次进编辑页必弹「已恢复未保存
--       的草稿内容」；② 草稿只在本机，换设备/清缓存即丢。改为服务端草稿：编辑中每隔 2s 自动落库，
--       草稿列表（后台「草稿箱」）里直接能看到、能打开继续编辑。
-- 列语义：
--   draft_of = NULL          : 普通文章 / 独立草稿（= 现状，存量行零回归）
--   draft_of = <其他行 id>   : 本行是那篇文章的「修改稿」。编辑已发布文章时自动保存写在本行，
--                              原文章行的任何列（尤其 updated_at / content）绝不被动，线上访客
--                              看到的仍是旧内容；点「发布」时才用它覆盖原文章行并删掉本行。
-- 为什么放在 note 表而不是新建 note_draft 表：草稿箱列表走的是 note 的 status='draft' 查询，
--   同表一行天然进列表、天然能用同一个编辑器打开，不需要 UNION 两套数据源。
-- 唯一索引：MySQL 唯一索引不约束多个 NULL（存量 23 行全部 draft_of IS NULL，零影响），
--   但它把「一篇文章至多一行修改稿」变成 DB 不变量——两个标签页/并发自动保存抢建时，
--   输的一方 INSERT 失败 → 前端 5s 重试 → 查到既有行改走原地更新，自愈，不留孤儿行。
ALTER TABLE `note`
    ADD COLUMN `draft_of` int DEFAULT NULL
        COMMENT '编辑修改稿：指向被编辑的原文章 id；NULL=普通文章/独立草稿',
    ADD UNIQUE KEY `uk_note_draft_of` (`draft_of`);

-- 校验门：必须看到 1 行 draft_of
SELECT 'columns' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'note'
  AND COLUMN_NAME IN ('draft_of')
ORDER BY COLUMN_NAME;

-- 存量分布：应全部为 NULL（4 行独立草稿 + 5 行私密 + 10 行公开）
SELECT 'existing' AS done, `status`, COUNT(*) AS cnt, SUM(`draft_of` IS NOT NULL) AS as_revision
FROM `note` GROUP BY `status`;

INSERT INTO migration_flags (flag_name) VALUES ('note_draft_link_20260912');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'note_draft_link_20260912';
