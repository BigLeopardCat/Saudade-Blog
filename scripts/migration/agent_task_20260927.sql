-- flag: agent_task_20260927（migration_flags，勿重跑）
USE saudade_blog;
CREATE TABLE IF NOT EXISTS `agent_task` (
    `id`                int NOT NULL AUTO_INCREMENT,
    `task_id`           varchar(64) NOT NULL COMMENT '系统生成的对外任务 id（at_+8位十六进制，跨语言契约）',
    `conversation_id`   int NOT NULL COMMENT '所属会话（读取/级联删按会话隔离）',
    `user_id`           int NOT NULL COMMENT '会话主人 uid（不参与展示）',
    `goal`              varchar(300) NOT NULL DEFAULT '' COMMENT '目标的人读表述（写时定稿；来源=主人原话）',
    `steps`             text NULL COMMENT '剩余步骤（JSON 数组，每步 {label,tool}；形状由 agent 定义，Rust 只做透传不解析）',
    `total_steps`       int NOT NULL DEFAULT 0 COMMENT '登记时的总步数（进度展示用，登记后不再变）',
    `cursor`            int NOT NULL DEFAULT 0 COMMENT '已推进步数（0..total_steps；与 steps 的下标语义由 agent 定义）',
    `state`             varchar(24) NOT NULL DEFAULT 'submitted' COMMENT 'submitted/running/input_required/succeeded/failed/cancelled',
    `pending_question`  varchar(300) NOT NULL DEFAULT '' COMMENT 'input_required 时要问主人的那句（下一轮原样回放，不由模型重编）',
    `idempotency_key`   varchar(80) DEFAULT NULL COMMENT '幂等键（会话+归一化目标+步骤集合；NULL 可重复，空串只能一行故不给默认值）',
    `attempts`          int NOT NULL DEFAULT 0 COMMENT '推进次数（同一轮反复推进同一行时可见）',
    `created_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `updated_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_at_task` (`task_id`),
    UNIQUE KEY `uk_at_idem` (`idempotency_key`),
    KEY `idx_at_conv_state` (`conversation_id`, `state`, `id`),
    KEY `idx_at_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='会话级任务状态：未完成的意图（与 execution_log 对偶）';

-- 应用后自检：表在不在、列齐不齐、此刻有几行（预期 0）
SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'agent_task';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'agent_task'
ORDER BY ORDINAL_POSITION;

SELECT '索引清单' AS done, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, NON_UNIQUE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'agent_task'
GROUP BY INDEX_NAME, NON_UNIQUE;

SELECT '当前行数（预期 0）' AS done, COUNT(*) AS 任务行数 FROM `agent_task`;

INSERT INTO migration_flags (flag_name) VALUES ('agent_task_20260927');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'agent_task_20260927';
