USE memory_blog;
-- =============================================================================
-- 站内信加「信件标题」（20260922，用户要求）
--
-- 背景：站内信箱本次只补这一列。**前端与后端代码已经先写了**——写技能/发送表单都传
-- `title`（选填），落库前统一 trim，空串一律存 NULL。所以本迁移没跑之前，
-- 「发站内信」这条链路会因为缺列而失败（sea-orm 的 INSERT 会带上 title）。
-- ⇒ **迁移没跑不许推送**（与 user_profile_center_20260922 同一口径）。
--
-- 幂等与执行前提：
--   · MySQL 不支持 `ADD COLUMN IF NOT EXISTS`，重复执行会报
--     `Duplicate column name 'title'` —— 那说明已经应用过了，停手即可。
--   · 不锁表：user_message 表当前行数是个位数，ADD COLUMN 是即时元数据变更。
--   · **纯结构变更，零数据回填**：历史行 title 保持 NULL，界面上显示「（无标题）」，
--     **不拿正文首行冒充标题**（那会把"没写标题"这条事实伪造掉）。
-- flag: user_message_title_20260922（migration_flags，勿重跑；本列的唯一记录）
--
-- 列定义与代码对齐的三处（改一处要三处一起改）：
--   1. 长度 varchar(60) ← Rust `MESSAGE_TITLE_MAX_CHARS = 60`、前端 `maxLength={60}`；
--   2. **可空**——"没填"只有一种表示（NULL），空串在写入口就被折成 NULL；
--   3. 位置 AFTER `to_user_id`（收件人 → 标题 → 正文，与 DTO 字段顺序一致，只为可读性）。
-- =============================================================================

-- 1) 信件标题（选填）
ALTER TABLE `user_message`
    ADD COLUMN `title` varchar(60) DEFAULT NULL
        COMMENT '信件标题（选填，20260922 起；历史行全为 NULL）'
        AFTER `to_user_id`;

-- 2) 应用后自检：列在不在、类型对不对、历史行是不是全 NULL
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'memory_blog'
  AND TABLE_NAME = 'user_message'
  AND COLUMN_NAME = 'title';

SELECT '历史行标题分布' AS done,
       COUNT(*)                                        AS 总行数,
       SUM(CASE WHEN `title` IS NULL THEN 1 ELSE 0 END) AS 无标题行
FROM `user_message`;

-- 3) flag（放在最后：跑到这行才算迁移完成）
INSERT INTO migration_flags (flag_name) VALUES ('user_message_title_20260922');
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'user_message_title_20260922';

-- 回滚（仅当本列确实要撤时——注意回滚会丢掉已写入的标题）：
--   ALTER TABLE `user_message` DROP COLUMN `title`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_message_title_20260922';
