USE memory_blog;
-- 20260912b 置顶轮播独立裁剪参数：note 表再补 3 列，让「置顶轮播」与「文章卡片」各用一套参数。
-- 背景：20260912 的 cover_focus_x/_y/_zoom 是一套参数喂所有展示位。置顶卡（.TopArticle 左列封面，
--       1440 宽下 ≈1.08:1）与文章卡片（盒高 200px，宽随栅格 ≈1.8:1）比例差得远，一套参数很难
--       同时满足两处 ⇒ 拆成两套：置顶轮播专用 carousel_*，文章卡片继续用 cover_*。
-- 分列语义（与 cover_* 同构）：
--   carousel_focus_x / carousel_focus_y : 焦点在图片内的归一化坐标，0..1（0.5 = 居中）
--   carousel_zoom                       : 在 cover 基准之上的额外放大倍数，1..4
--   NULL（三列任一为 NULL 即整组作废）  : 未设置 ⇒ 轮播回退跟随 cover_*（= 改造前的行为，存量行零回归）
-- 渲染等价关系与 cover_* 一致：object-position + transform-origin + transform: scale(z)。
-- 注意：现有 cover_* 三列语义不变，继续当「文章卡片」那套，存量数据零迁移。
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
