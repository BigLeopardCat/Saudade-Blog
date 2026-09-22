USE memory_blog;
-- =============================================================================
-- 个人中心一期（20260922）：头像 + 收藏 + 站内通知 + 站内信箱
--
-- 本迁移只建**结构**，不含任何数据回填：四条能力的前端与端点随后分批次交付
-- （先端点、后界面），所以这里刻意不写"默认值/首行数据"之类会与后一批打架的东西。
--
-- 幂等与执行前提：
--   · 三条 CREATE TABLE 都带 IF NOT EXISTS；
--   · 唯一的 ALTER（user.avatar）**没有** IF NOT EXISTS（MySQL 不支持），
--     重复执行会报 `Duplicate column name 'avatar'` —— 那说明已经应用过了，停手即可。
--   · 不锁表：user 表很小（个位数行），ADD COLUMN 是即时元数据变更。
-- flag: user_profile_center_20260922（migration_flags，勿重跑；建号/建表的唯一记录）
--
-- 与既有口径对齐的三件事（写在这里，免得下一个人踩）：
--   1. 全库时间列一律 DATETIME 存 **+08:00 本地钟面**（20260827 统一，禁二次偏移）；
--   2. 所有指向 user 的外键都 ON DELETE CASCADE —— 删号即清干净，不留孤儿；
--   3. 不做"软删除"列：本期的删除语义都是真删（收藏取消=删行、通知清理=删行）。
-- =============================================================================

-- 1) 头像 URL（上传裁切完成后落库，前端按 github 那套交互：先选图 → 裁切 → 再上传）
ALTER TABLE `user`
    ADD COLUMN `avatar` varchar(255) DEFAULT NULL
        COMMENT '头像 URL（裁切后上传产出的站内路径）'
        AFTER `nickname`;

-- 2) 收藏的文章（用户 ←→ 文章，唯一约束保证重复收藏是幂等的）
CREATE TABLE IF NOT EXISTS `user_favorite` (
    `id`         int NOT NULL AUTO_INCREMENT,
    `user_id`    int NOT NULL COMMENT '收藏者',
    `note_id`    int NOT NULL COMMENT '被收藏的文章 note.id',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_favorite_user_note` (`user_id`, `note_id`),
    -- 反向查询：这篇文章被多少人收藏（文章页/后台都可能要）
    KEY `idx_favorite_note` (`note_id`),
    CONSTRAINT `fk_favorite_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE,
    -- 文章删除 ⇒ 收藏一起消失（不留指向空气的收藏行）
    CONSTRAINT `fk_favorite_note` FOREIGN KEY (`note_id`) REFERENCES `note` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) 站内通知 / 公告（红点与"站内公告和通知"面板的数据源）
--    type 是**留给后续扩展的接口**，今天只写两类：
--      'announcement' = 站内公告（管理员发布，管理员可用后端已有的公告端点同步触发）
--      'notice'       = 站内通知（面向单个用户的系统消息：审核结果、被回复…）
--    user_id **不做"0 = 全体"的广播哨兵**：那会与 ON DELETE CASCADE 打架（0 没有对应行），
--    公告改用**写入时按用户展开**（个位数用户的站，展开最省心、也最好查"谁读过"）。
CREATE TABLE IF NOT EXISTS `user_notification` (
    `id`         int NOT NULL AUTO_INCREMENT,
    `user_id`    int NOT NULL COMMENT '收件人',
    `type`       varchar(16) NOT NULL COMMENT "announcement=站内公告 / notice=站内通知（留接口）",
    `title`      varchar(128) NOT NULL,
    `content`    text NULL,
    `link`       varchar(255) DEFAULT NULL COMMENT '站内路径（点通知跳过去），NULL = 纯文本通知',
    `is_read`    tinyint(1) NOT NULL DEFAULT 0 COMMENT '头像红点/未读数按它统计',
    `read_at`    datetime DEFAULT NULL,
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    -- 唯一的高频查询：某人的未读，按时间倒序
    KEY `idx_notification_user_read_created` (`user_id`, `is_read`, `created_at`),
    CONSTRAINT `fk_notification_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) 站内信箱（用户 ←→ 用户；本期不做会话线程，一条消息一行，回复=新的一行）
CREATE TABLE IF NOT EXISTS `user_message` (
    `id`           int NOT NULL AUTO_INCREMENT,
    `from_user_id` int NOT NULL,
    `to_user_id`   int NOT NULL,
    `content`      text NOT NULL,
    `is_read`      tinyint(1) NOT NULL DEFAULT 0,
    `read_at`      datetime DEFAULT NULL,
    `created_at`   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    KEY `idx_message_to_read_created` (`to_user_id`, `is_read`, `created_at`),
    -- 两个人之间的往来（"我和他的信箱"）
    KEY `idx_message_pair_created` (`from_user_id`, `to_user_id`, `created_at`),
    CONSTRAINT `fk_message_from` FOREIGN KEY (`from_user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_message_to` FOREIGN KEY (`to_user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO migration_flags (flag_name) VALUES ('user_profile_center_20260922');
