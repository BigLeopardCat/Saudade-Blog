USE saudade_blog;
ALTER TABLE `note`
    ADD COLUMN `carousel_focus_x` double DEFAULT NULL
        COMMENT '置顶轮播焦点X(0..1归一化, 0.5=居中; NULL=未设置回退跟随 cover_focus_x)',
    ADD COLUMN `carousel_focus_y` double DEFAULT NULL
        COMMENT '置顶轮播焦点Y(0..1归一化, 0.5=居中; NULL=未设置回退跟随 cover_focus_y)',
    ADD COLUMN `carousel_zoom` double DEFAULT NULL
        COMMENT '置顶轮播额外缩放倍数(1..4; NULL=未设置回退跟随 cover_zoom)';

-- 校验门：必须看到 3 行 carousel_focus_x / carousel_focus_y / carousel_zoom
SELECT 'columns' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'note'
  AND COLUMN_NAME IN ('carousel_focus_x', 'carousel_focus_y', 'carousel_zoom')
ORDER BY COLUMN_NAME;

INSERT INTO migration_flags (flag_name) VALUES ('note_carousel_crop_20260912');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'note_carousel_crop_20260912';
