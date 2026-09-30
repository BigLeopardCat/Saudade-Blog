USE memory_blog;
-- =============================================================================
-- 文章阅读量 / 点赞量（20260930）
--
-- 本迁移只建**结构**，不含任何数据回填：两张表今天都是空的（0 行即"还没有人读过"），
-- 前端上报（POST /api/public/notes/:id/view）与点赞从零开始积累。刻意不写
-- "把历史估算补进去"之类的东西——补出来的数不是事实，报表上分不出真假。
--
-- 幂等与执行前提：
--   · 两条 CREATE TABLE 都带 IF NOT EXISTS；
--   · 没有 ALTER、没有数据回填 ⇒ 重复执行完全无害（不是"会报错但说明已应用"，
--     而是纯空操作）。
--   · 不锁表：新建空表，与既有表零交互。
-- flag: note_stats_20260930（migration_flags，勿重跑；建表的唯一记录）
--
-- ★ 两条语义必须写在这里，否则下一个人会按错的前提改代码：
--
--   1. **总阅读量会变小**。`note_view.note_id` 与 `note_like.note_id` 都是
--      ON DELETE CASCADE —— 删掉一篇文章，它的阅读量与点赞行一起消失。
--      "阅读量只增不减"在这个模型下**不成立**，任何按它做的假设（缓存总量、
--      把差值当增量、报表里断言单调递增）都会在某次删文章后失效。
--      要留"只增不减"就得改软删除，那是另一件事，不在本期。
--
--   2. **文章转草稿/转私密不触发 CASCADE**。CASCADE 只认 DELETE，不认 UPDATE：
--      `is_public=false` 或 `status='draft'` 之后，这两张表里的行**还在**。
--      所以**报表查询必须自己 join `note` 的可见性**（is_public 且非 draft），
--      否则排行榜会把已经下架的文章连同标题一起列出来。
--      读取端另有 `visible_note` 判据（src/routes/notes.rs），两处要求一致。
--
-- 与既有口径对齐：全库时间列一律 DATETIME 存 **+08:00 本地钟面**（20260827 统一，
-- 禁二次偏移）；指向 note/user 的外键一律 ON DELETE CASCADE（同 user_favorite）。
-- =============================================================================

-- 1) 阅读量：**一篇文章一天一行**（不是"一个访客一行"——那是埋点，不是报表）。
--    总量   = SUM(cnt) over note_id
--    日趋势 = GROUP BY view_date
--    一条表两用，刻意**不另立"总量表"**：那是第二份真相源，要原子双写，收益为零
--    （50 篇 × 365 天 ≈ 1.8 万行/年，MySQL 眼里是零）。
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
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME IN ('note_view', 'note_like')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
