-- flag: dashboard_todo_20260924（migration_flags，勿重跑）
USE saudade_blog;
CREATE TABLE IF NOT EXISTS `dashboard_todo` (
    `id`         int NOT NULL AUTO_INCREMENT,
    `user_id`    int NOT NULL COMMENT '待办的主人（后台仅管理员，仍按 uid 过滤）',
    `sort_order` int NOT NULL DEFAULT 0 COMMENT '列表里的位次（0 起，由前端数组下标决定）',
    `text`       varchar(200) NOT NULL COMMENT '待办正文（已 trim，空行不落库）',
    `done`       tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否已完成',
    `due_date`   date NULL COMMENT '排期那天；NULL = 未排期',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    -- 唯一的读取路径：某用户的列表按位次取
    KEY `idx_dt_user_sort` (`user_id`, `sort_order`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 应用后自检：表在不在、列齐不齐、此刻有几行（预期 0）
SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'dashboard_todo';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'dashboard_todo'
ORDER BY ORDINAL_POSITION;

SELECT '当前行数（预期 0）' AS done, COUNT(*) AS 待办行数 FROM `dashboard_todo`;

INSERT INTO migration_flags (flag_name) VALUES ('dashboard_todo_20260924');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'dashboard_todo_20260924';

-- 回滚（本次没有历史数据依赖，回滚即删表；删表前若要留一份，先导出）：
--   DROP TABLE `dashboard_todo`;
--   DELETE FROM migration_flags WHERE flag_name = 'dashboard_todo_20260924';
