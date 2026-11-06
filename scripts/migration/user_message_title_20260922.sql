-- flag: user_message_title_20260922（migration_flags，勿重跑；本列的唯一记录）
USE saudade_blog;
ALTER TABLE `user_message`
    ADD COLUMN `title` varchar(60) DEFAULT NULL
        COMMENT '信件标题（选填，20260922 起；历史行全为 NULL）'
        AFTER `to_user_id`;

-- 2) 应用后自检：列在不在、类型对不对、历史行是不是全 NULL
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'saudade_blog'
  AND TABLE_NAME = 'user_message'
  AND COLUMN_NAME = 'title';

SELECT '历史行标题分布' AS done,
       COUNT(*)                                        AS 总行数,
       SUM(CASE WHEN `title` IS NULL THEN 1 ELSE 0 END) AS 无标题行
FROM `user_message`;

-- 3) flag（放在最后：跑到这行才算迁移完成）
INSERT INTO migration_flags (flag_name) VALUES ('user_message_title_20260922');
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'user_message_title_20260922';

-- 回滚（仅当本列确实要撤时——注意回滚会丢掉已写入的标题）：
--   ALTER TABLE `user_message` DROP COLUMN `title`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_message_title_20260922';
