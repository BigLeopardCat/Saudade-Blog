-- flag: talk_reject_reason_20260923（migration_flags，勿重跑）
USE saudade_blog;
ALTER TABLE `talk`
    ADD COLUMN `reject_reason` varchar(200) DEFAULT NULL
        COMMENT '驳回理由: AI 判定说明或管理员手填；改判通过时清空'
        AFTER `ai_result`;

-- 校验门：必须看到 1 行 reject_reason
SELECT 'columns' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
  AND COLUMN_NAME IN ('reject_reason')
ORDER BY COLUMN_NAME;

-- 列清单（确认新列紧跟在 ai_result 之后）
SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
ORDER BY ORDINAL_POSITION;

-- 存量分布：应为 0 行（纯新增列，存量行全部 NULL）
SELECT '现有理由行数（预期 0）' AS done, COUNT(*) AS with_reason
FROM `talk` WHERE `reject_reason` IS NOT NULL;

INSERT INTO migration_flags (flag_name) VALUES ('talk_reject_reason_20260923');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'talk_reject_reason_20260923';

-- 回滚（理由列没有历史数据依赖，回滚即丢理由文本）：
--   ALTER TABLE `talk` DROP COLUMN `reject_reason`;
--   DELETE FROM migration_flags WHERE flag_name = 'talk_reject_reason_20260923';
