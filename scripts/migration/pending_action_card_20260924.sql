-- flag: pending_action_card_20260924（migration_flags，勿重跑）
USE saudade_blog;
ALTER TABLE `pending_action`
    ADD COLUMN `question` varchar(500) NOT NULL DEFAULT ''
        COMMENT '确认卡片问句（与弹窗同源，写时定稿；空串=这张卡片不可重建）'
        AFTER `target`,
    ADD COLUMN `options` varchar(600) NOT NULL DEFAULT ''
        COMMENT '选项 JSON（label/value/kind；前端不自己造按钮）'
        AFTER `question`,
    ADD COLUMN `jti` varchar(64) NOT NULL DEFAULT ''
        COMMENT '令牌 id（签在令牌里）——原子核销的键'
        AFTER `options`,
    ADD COLUMN `expires_at` datetime DEFAULT NULL
        COMMENT '令牌到期时刻（取自令牌自身 exp，展示/过滤用；验签才是唯一凭据）'
        AFTER `jti`,
    ADD COLUMN `claimed_at` datetime DEFAULT NULL
        COMMENT '被认领时刻；NULL=还没被用掉（一次性核销的判据）'
        AFTER `expires_at`,
    ADD KEY `idx_pa_jti_claim` (`jti`, `claimed_at`);

-- 应用后自检：5 列都在、类型对不对、这几个键有没有建上
SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'pending_action'
  AND COLUMN_NAME IN ('question', 'options', 'jti', 'expires_at', 'claimed_at')
ORDER BY ORDINAL_POSITION;

SELECT '应恰为 5 列' AS done, COUNT(*) AS 新列数
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'pending_action'
  AND COLUMN_NAME IN ('question', 'options', 'jti', 'expires_at', 'claimed_at');

SELECT '核销索引' AS done, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS 列
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'pending_action'
  AND INDEX_NAME = 'idx_pa_jti_claim'
GROUP BY INDEX_NAME;

SELECT '存量行' AS done, COUNT(*) AS 行数,
       SUM(CASE WHEN `jti` = '' THEN 1 ELSE 0 END) AS 无令牌行
FROM `pending_action`;

-- flag（放在最后：跑到这行才算迁移完成）
INSERT INTO migration_flags (flag_name) VALUES ('pending_action_card_20260924');
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'pending_action_card_20260924';

-- 回滚（只在确实要撤时用；注意撤列会一并丢掉"哪张卡片已被认领"的记录）：
--   ALTER TABLE `pending_action` DROP INDEX `idx_pa_jti_claim`,
--     DROP COLUMN `claimed_at`, DROP COLUMN `expires_at`,
--     DROP COLUMN `jti`, DROP COLUMN `options`, DROP COLUMN `question`;
--   DELETE FROM migration_flags WHERE flag_name = 'pending_action_card_20260924';
