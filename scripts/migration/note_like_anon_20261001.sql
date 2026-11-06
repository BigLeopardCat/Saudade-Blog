-- flag: note_like_anon_20261001（migration_flags，勿重跑）
USE saudade_blog;
ALTER TABLE `note_like`
    MODIFY COLUMN `user_id` int NULL
        COMMENT '点赞的账号（登录用户）；匿名为 NULL',
    ADD COLUMN `visitor_key` varchar(64) NULL
        COMMENT '匿名访客标识（浏览器生成、随 X-Visitor-Key 上报）；登录行为 NULL'
        AFTER `user_id`,
    ADD UNIQUE KEY `uq_like_note_visitor` (`note_id`, `visitor_key`);

INSERT INTO migration_flags (flag_name) VALUES ('note_like_anon_20261001');

-- ① 自检：两列的形状对得上
-- 期望：2 行。`user_id` IS_NULLABLE=YES、类型 int；
--       `visitor_key` IS_NULLABLE=YES、varchar(64)、紧排在 user_id 之后。
SELECT '列' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_like'
   AND COLUMN_NAME IN ('user_id', 'visitor_key')
 ORDER BY ORDINAL_POSITION;

-- ② 自检：两条唯一键都在，且各自的分列对得上
-- 期望：uq_like_note_user = (note_id, user_id) 两条分列；
--       uq_like_note_visitor = (note_id, visitor_key) 两条分列。
SELECT '唯一键' AS done, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_like'
   AND INDEX_NAME IN ('uq_like_note_user', 'uq_like_note_visitor')
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- ③ 存量行核对：跑完本文件（还没上代码）时，匿名行必须是 0 行
-- 期望：总数不变、`匿名的行数` = 0。**若不为 0，先停手查清是谁写的**——
-- 本文件不造任何匿名行，能写出 visitor_key 的代码在本次部署之后才存在。
SELECT '存量行' AS done,
       COUNT(*)                     AS 点赞总数,
       SUM(user_id IS NULL)         AS 匿名的行数,
       SUM(visitor_key IS NOT NULL) AS 带访客标识的行数
  FROM `note_like`;

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'note_like_anon_20261001';

-- 回滚（如需）
-- 顺序有讲究：**先删匿名行**，否则 `MODIFY ... NOT NULL` 会因为 user_id 为 NULL
-- 的行而失败（或按 sql_mode 被静默填 0 —— 那更糟，会凭空造出指向 user 0 的点赞）。
--   DELETE FROM `note_like` WHERE `user_id` IS NULL;
--   ALTER TABLE `note_like` DROP INDEX `uq_like_note_visitor`, DROP COLUMN `visitor_key`,
--                           MODIFY COLUMN `user_id` int NOT NULL COMMENT '点赞者（仅登录用户可点赞，不存在匿名行）';
--   DELETE FROM migration_flags WHERE flag_name = 'note_like_anon_20261001';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码一律按这两列读写，
--    列没了就是点赞接口 500（与"没跑迁移就推送"同一种破坏）。
-- ⚠️ 上面那句 DELETE 是**不可逆的**：匿名点赞没有别处的副本，删掉就没了。
--    真要回滚，先把那几行 `SELECT *` 存下来。
