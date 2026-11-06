-- flag: pending_action_20260923（migration_flags，勿重跑）
USE saudade_blog;
CREATE TABLE IF NOT EXISTS `pending_action` (
    `id`                    int NOT NULL AUTO_INCREMENT,
    `task_id`               varchar(64) NOT NULL DEFAULT '' COMMENT '系统生成的待办 id',
    `conversation_id`       int NOT NULL COMMENT '所属会话（读取/关闭/清理按会话隔离）',
    `user_id`               int NOT NULL COMMENT '会话主人 uid（不参与展示）',
    `skill`                 varchar(32) NOT NULL DEFAULT '' COMMENT '技能名',
    `tool`                  varchar(255) NOT NULL DEFAULT '' COMMENT '工具体（逗号分隔；回执关闭的判据）',
    `args`                  text NULL COMMENT '结构化参数（specs 的 JSON，审计线索；超 4000 字符只存前缀）',
    `target`                varchar(300) NOT NULL DEFAULT '' COMMENT '写时定稿的人读目标+动作（与确认弹窗同源）',
    `requested_by`          varchar(32) NOT NULL DEFAULT 'user' COMMENT 'user=主人本轮提出 / system=系统事件自我提出',
    `source_event`          varchar(64) NOT NULL DEFAULT '' COMMENT '具体来源（confirm_popup…）',
    `confirmation_required` tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否需要主人点头',
    `confirmation_status`   varchar(24) NOT NULL DEFAULT 'awaiting' COMMENT 'awaiting/confirmed/expired',
    `status`                varchar(24) NOT NULL DEFAULT 'pending' COMMENT 'pending/done/superseded/cancelled',
    `created_at`            datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `updated_at`            datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    -- 唯一的高频查询：某会话仍 pending 的最新一条
    KEY `idx_pa_conv_status` (`conversation_id`, `status`, `id`),
    KEY `idx_pa_task` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 应用后自检：表在不在、列齐不齐、此刻有几行（预期 0）
SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'pending_action';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'pending_action'
ORDER BY ORDINAL_POSITION;

SELECT '当前行数（预期 0）' AS done, COUNT(*) AS 待办行数 FROM `pending_action`;

INSERT INTO migration_flags (flag_name) VALUES ('pending_action_20260923');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'pending_action_20260923';

-- 回滚（本次没有历史数据依赖，回滚即删表；若主人手上有未办完的待办请先导出）：
--   DROP TABLE `pending_action`;
--   DELETE FROM migration_flags WHERE flag_name = 'pending_action_20260923';
