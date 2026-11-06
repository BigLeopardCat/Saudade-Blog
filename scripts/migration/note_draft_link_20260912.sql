USE saudade_blog;
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
