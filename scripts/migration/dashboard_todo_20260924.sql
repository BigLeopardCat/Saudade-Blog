USE memory_blog;
-- =============================================================================
-- 后台首页待办表（20260924）：dashboard_todo
--
-- 背景：后台首页右栏那张待办卡（可打勾、可拖拽排序、可按日期分组、逾期标红）
-- 此前整份列表存在**浏览器 localStorage** 里（键 `dashboard_todos`）。两个后果：
--   · 换浏览器 / 换设备 / 清了站点数据，待办就没了；
--   · 多台设备各存一份，互相看不见。
-- 这张表把「此刻的这份列表」按用户存到库里。
--
-- 形态：**全量替换**，不是逐行 CRUD。
--   GET  /api/protected/todos → 该用户按 sort_order 排好的整份列表
--   PUT  /api/protected/todos → 整份列表覆盖（事务内先删该用户全部行、再逐条插入）
--   为什么不做行级增删改：这份列表的**顺序与身份都由前端拥有**——拖拽换位、空行回收、
--   行文本就地编辑，前端手里本来就只有一个数组。按行做要引入稳定的行 id，前端就得
--   维护一套 id 对账；而 React 的行 key 一旦跟着服务端 id 变，每次保存都会重挂正在
--   打字的那一行（输入框当场失焦）。全量替换与数据模型一一对应，也不需要 client_key。
--   代价如实记：两个标签页同时编辑 = 后写的那份整体覆盖前面那份（后台只有主人一个人
--   在用，可接受；真要多端并发编辑，这里得改成按行 + 版本号）。
--
-- 无外键约束：`user_id` 只是过滤条件（本表删除随会话无关、也不参与任何级联）。
--   销号时 `user` 行的删除不会带走这里的行——本仓既有形态（user_message_draft 同样
--   不建外键），如实记在这里，不假装有级联。
--
-- 幂等与执行前提：
--   · CREATE TABLE IF NOT EXISTS：重复执行安全；新表此刻必然 0 行，不锁表；
--   · 纯结构变更，零数据回填（localStorage 里的旧待办不会被搬上来）；
--   · **迁移没跑不许推送**：Rust 一上线就读写它（GET 失败前端按"列表没加载出来"
--     如实提示并可重试，PUT 失败保留本地编辑并提示，不会静默丢数据）。
-- flag: dashboard_todo_20260924（migration_flags，勿重跑）
-- =============================================================================

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
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'dashboard_todo';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'dashboard_todo'
ORDER BY ORDINAL_POSITION;

SELECT '当前行数（预期 0）' AS done, COUNT(*) AS 待办行数 FROM `dashboard_todo`;

INSERT INTO migration_flags (flag_name) VALUES ('dashboard_todo_20260924');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'dashboard_todo_20260924';

-- 回滚（本次没有历史数据依赖，回滚即删表；删表前若要留一份，先导出）：
--   DROP TABLE `dashboard_todo`;
--   DELETE FROM migration_flags WHERE flag_name = 'dashboard_todo_20260924';
