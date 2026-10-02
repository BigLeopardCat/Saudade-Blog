USE saudade_blog;
-- =============================================================================
-- 站内信草稿箱（20260923，用户要求「再加上草稿箱」）
--
-- 背景：站内信箱本次从两个签页（收件箱/发件箱）扩成四个（+ 草稿箱 / 写站内信），
-- 草稿要有地方存。**后端与前端代码先写**——端点一上线就会读写这张表，所以
-- ⇒ **迁移没跑不许推送**（与 user_message_title_20260922 / user_profile_center_20260922
-- 同一口径）。
--
-- 幂等与执行前提：
--   · CREATE TABLE IF NOT EXISTS：重复执行安全；
--   · 不锁表：user_message_draft 是**新表**，此刻必然 0 行；
--   · **纯结构变更，零数据回填**：不替任何人造草稿，也不搬历史信件。
-- flag: user_message_draft_20260923（migration_flags，勿重跑）
--
-- 三个设计决定，都写在这儿免得下一个人改错：
--   1. **草稿不是信**：不收件、不进未读红点、不进别人的任何列表——所以它是独立一张表，
--      不是给 user_message 加 `is_draft` 列（那样每一处收/发件箱查询都要记得过滤，
--      漏一处就把别人的草稿漏进了收件箱）。
--   2. **to_username 存用户敲的原文**（账号或 UID），不是解析后的 user.id：草稿允许
--      填一个还不存在的收件人/干脆留空，解析只在真正发送时做（那时的报错才有效）。
--      ⇒ 因此**没有**指向 user 的外键（除了主人 user_id）。
--   3. 主人 user_id → ON DELETE CASCADE：删号即清干净，不留孤儿草稿。
-- =============================================================================

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
