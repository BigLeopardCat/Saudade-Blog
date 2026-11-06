-- flag: user_message_draft_20260923（migration_flags，勿重跑）
USE saudade_blog;
CREATE TABLE IF NOT EXISTS `user_message_draft` (
    `id`          int NOT NULL AUTO_INCREMENT,
    `user_id`     int NOT NULL COMMENT '草稿主人',
    `to_username` varchar(64) DEFAULT NULL COMMENT '收件人原文（账号或 UID，发送时才解析）',
    `title`       varchar(60) DEFAULT NULL COMMENT '信件标题（与 user_message.title 同长度）',
    `content`     text NULL COMMENT '正文（上限 500 字在应用层校验，与 user_message 同口径）',
    `created_at`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `updated_at`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    -- 唯一的高频查询：某人的草稿，按最近改过的在前
    KEY `idx_draft_user_updated` (`user_id`, `updated_at`),
    CONSTRAINT `fk_draft_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 应用后自检：表在不在、列齐不齐、此刻有几行（预期 0）
SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user_message_draft';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user_message_draft'
ORDER BY ORDINAL_POSITION;

SELECT '当前行数（预期 0）' AS done, COUNT(*) AS 草稿行数 FROM `user_message_draft`;

INSERT INTO migration_flags (flag_name) VALUES ('user_message_draft_20260923');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'user_message_draft_20260923';

-- 回滚（本次没有历史数据依赖，回滚即删表；若已有真实草稿请先导出）：
--   DROP TABLE `user_message_draft`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_message_draft_20260923';
