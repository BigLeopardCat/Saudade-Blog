-- flag: talk_ai_reason_20260926（migration_flags，勿重跑）
USE saudade_blog;
ALTER TABLE `talk`
    ADD COLUMN `ai_reason` varchar(200) DEFAULT NULL
        COMMENT 'AI 审核说明(所有裁决都留痕); 人工未填驳回理由时回落到它'
        AFTER `reject_reason`;

-- 校验门：必须看到 1 行 ai_reason
SELECT 'columns' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
  AND COLUMN_NAME IN ('ai_reason')
ORDER BY COLUMN_NAME;

-- 列清单（确认新列紧跟在 reject_reason 之后）
SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
ORDER BY ORDINAL_POSITION;

SELECT '现有 AI 说明行数（预期 0）' AS done, COUNT(*) AS with_ai_reason
FROM `talk` WHERE `ai_reason` IS NOT NULL;

-- 顺带把"理由显示为未填写"的存量规模留在执行记录里（只读，不是判据）：
-- 已驳回但没有任何理由的行，就是后台「评论管理」里那些"未填写"。
SELECT '已驳回且无理由的存量行' AS done, COUNT(*) AS rejected_without_reason
FROM `talk` WHERE `approved` = 2 AND (`reject_reason` IS NULL OR `reject_reason` = '');

INSERT INTO migration_flags (flag_name) VALUES ('talk_ai_reason_20260926');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'talk_ai_reason_20260926';
