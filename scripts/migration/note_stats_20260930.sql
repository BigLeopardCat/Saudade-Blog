-- flag: note_stats_20260930（migration_flags，勿重跑；建表的唯一记录）
USE saudade_blog;
CREATE TABLE IF NOT EXISTS `note_view` (
    `id`        int NOT NULL AUTO_INCREMENT,
    `note_id`   int NOT NULL COMMENT '被阅读的文章 note.id',
    `view_date` date NOT NULL COMMENT '统计日（服务端 +08:00 本地钟面取日）',
    `cnt`       int NOT NULL DEFAULT 0 COMMENT '这一天该文章的阅读次数（同一访客同一天只计一次，去重在前端）',
    PRIMARY KEY (`id`),
    -- 排行榜 / 单篇总量：`WHERE note_id = ?` 或按 note_id 聚合，最左列正好是它
    UNIQUE KEY `uq_view_note_date` (`note_id`, `view_date`),
    -- ★ 反向索引**必须**补：日趋势是 `WHERE view_date BETWEEN ... GROUP BY view_date`，
    -- **用不上** uq_view_note_date（最左列是 note_id）。少了这条，30 天趋势会全表扫。
    KEY `idx_view_date` (`view_date`),
    -- 文章删除 ⇒ 它的阅读记录一起消失（见头注语义 ①：总量因此会变小）
    CONSTRAINT `fk_view_note` FOREIGN KEY (`note_id`) REFERENCES `note` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) 点赞：与 user_favorite 同形（唯一约束让"重复点赞"天然幂等）。
--    `created_at` **不能是裸 datetime**：entity 里它是非 Option 的 DateTime，
--    NULL 会在 sea-orm 解码时直接炸（同 user_favorite.created_at 的处理）。
CREATE TABLE IF NOT EXISTS `note_like` (
    `id`         int NOT NULL AUTO_INCREMENT,
    `note_id`    int NOT NULL COMMENT '被点赞的文章 note.id',
    `user_id`    int NOT NULL COMMENT '点赞者（仅登录用户可点赞，不存在匿名行）',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    -- 同一个人对同一篇只能有一行 ⇒ 重复点赞是幂等的
    UNIQUE KEY `uq_like_note_user` (`note_id`, `user_id`),
    -- 反向：这篇文章被多少人点赞（列表/报表都要）
    KEY `idx_like_note` (`note_id`),
    -- 文章删除 ⇒ 点赞一起消失（见头注语义 ①）
    CONSTRAINT `fk_like_note` FOREIGN KEY (`note_id`) REFERENCES `note` (`id`) ON DELETE CASCADE,
    -- 销号 ⇒ 他点过的赞一起消失（不留指向空气的点赞行）
    CONSTRAINT `fk_like_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO migration_flags (flag_name) VALUES ('note_stats_20260930');

-- 校验：两张表都在、索引条数对得上（期望 note_view 3 条、note_like 3 条）
SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME IN ('note_view', 'note_like')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
