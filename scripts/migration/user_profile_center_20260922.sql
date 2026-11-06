-- flag: user_profile_center_20260922（migration_flags，勿重跑；建号/建表的唯一记录）
USE saudade_blog;
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
