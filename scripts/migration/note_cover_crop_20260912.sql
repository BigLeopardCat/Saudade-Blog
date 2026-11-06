USE saudade_blog;
ALTER TABLE `note`
    ADD COLUMN `cover_focus_x` double DEFAULT NULL
        COMMENT '封面焦点X(0..1归一化, 0.5=居中; NULL=未设置按居中)',
    ADD COLUMN `cover_focus_y` double DEFAULT NULL
        COMMENT '封面焦点Y(0..1归一化, 0.5=居中; NULL=未设置按居中)',
    ADD COLUMN `cover_zoom` double DEFAULT NULL
        COMMENT '封面额外缩放倍数(1..4, 1=不额外放大; NULL=未设置)';

-- 校验门：必须看到 3 行 cover_focus_x / cover_focus_y / cover_zoom
SELECT 'columns' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'note'
  AND COLUMN_NAME IN ('cover_focus_x', 'cover_focus_y', 'cover_zoom')
ORDER BY COLUMN_NAME;

INSERT INTO migration_flags (flag_name) VALUES ('note_cover_crop_20260912');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'note_cover_crop_20260912';
