-- flag: note_author_20261001（migration_flags，勿重跑）
USE saudade_blog;
ALTER TABLE `note`
    ADD COLUMN `user_id` int NULL DEFAULT NULL
        COMMENT '发布者 user.id；NULL = 未记录（老文章或账号已销）⇒ 展示端回退站点级署名'
        AFTER `draft_of`;

INSERT INTO migration_flags (flag_name) VALUES ('note_author_20261001');

-- 校验：列在、类型对、存量行全是 NULL（期望 null_rows = total_rows）
SELECT 'column' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note' AND COLUMN_NAME = 'user_id';

SELECT 'rows' AS done,
       (SELECT COUNT(*) FROM note) AS total_rows,
       (SELECT COUNT(*) FROM note WHERE user_id IS NULL) AS null_rows,
       (SELECT COUNT(*) FROM note WHERE user_id IS NOT NULL) AS authored_rows;
