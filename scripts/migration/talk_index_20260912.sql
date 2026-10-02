USE saudade_blog;
-- 20260912d 河灯留言板（talk 表 src='board'）列表查询补索引。
-- 背景：talk 表原来只有 PRIMARY(id) 一个索引，四条列表查询 EXPLAIN 实测全是
--       `type=ALL + Using where + Using filesort`（29 行时不显，留言多起来就是
--       每次打开留言板全表扫 + 全表排序，content 是 TEXT 还会带上行外页读取）。
-- 查询形态（src/routes/talks.rs）：
--   list_by_src(board/talk)   WHERE src=? AND approved=1            ORDER BY created_at DESC, id DESC
--   list_my_boards            WHERE src='board' AND user_id=?       ORDER BY created_at DESC, id DESC
--   list_board_admin          WHERE src='board'                     ORDER BY created_at DESC, id DESC
-- 列序规则：等值列在前、排序列垫底 —— 最左前缀直接吃掉 ORDER BY，消掉 filesort。
-- 三条互不覆盖：带 approved 过滤的那条不能与 (src, created_at) 共用同一条排序路径。
-- 说明：handler 侧同时补了 `ORDER BY id DESC` 兜底（created_at 是秒级精度，同秒多行
--       排序不稳定；加索引后返回顺序可能变，补 id 后新旧结果逐字节一致）。
ALTER TABLE `talk`
    ADD KEY `idx_talk_src_appr_created` (`src`, `approved`, `created_at`),
    ADD KEY `idx_talk_src_user_created` (`src`, `user_id`, `created_at`),
    ADD KEY `idx_talk_src_created`      (`src`, `created_at`);

-- 校验门：必须看到 3 条新索引（共 9 行：每条索引 3 列）
SELECT 'indexes' AS done, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
  AND INDEX_NAME LIKE 'idx_talk_%'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 存量分布（只读核对：本迁移不改任何行）
SELECT 'existing' AS done, `src`, COUNT(*) AS cnt, SUM(`approved` = 1) AS approved
FROM `talk` GROUP BY `src`;

INSERT INTO migration_flags (flag_name) VALUES ('talk_index_20260912');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'talk_index_20260912';
