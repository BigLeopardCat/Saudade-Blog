USE memory_blog;
-- 20260912 文章封面裁剪参数：note 表补 3 列，保存「焦点 + 缩放」而非烘焙新图。
-- 背景：封面在首页置顶轮播(≈1:1) / 首页文章卡片(盒高200px，宽随栅格 ≈1.82:1) /
--       详情页横幅(400px高全宽 ≈3.5:1) 三处展示，全是 object-fit:cover 居中自动裁。
--       同一张图在 1:1 ~ 3.5:1 的窗口里强制居中裁，主体（人脸/文字/logo）常被裁掉半截。
--       三处窗口比例跨度太大，一张烘焙图满足不了 ⇒ 存参数，展示端按各自窗口重算裁剪。
-- 分列语义：
--   cover_focus_x / cover_focus_y : 焦点在图片内的归一化坐标，0..1（0.5 = 居中）
--   cover_zoom                    : 在 cover 基准之上的额外放大倍数，1..4（1 = 不额外放大）
--   NULL                          : 从未设置 ⇒ 展示端不输出任何裁剪样式，回退现状（存量行不回溯）
-- 渲染等价关系（展示端）：
--   object-position: x% y%; transform-origin: x% y%; transform: scale(z)
--   ⇔ 图片按 cover 放大 z 倍后，图片 (x,y) 点对齐窗口 (x,y) 点；焦点永不偏移、窗口无空隙。
--   参数与窗口比例无关，故同一组参数在任意展示位自动适配。
-- x=y=0.5 且 z=1 时与改造前逐像素一致。
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
