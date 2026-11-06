-- 部署顺序：迁移先跑，依赖新增列的代码后 push；回滚先退代码，再删列。
-- flag: user_mute_20261002（migration_flags，勿重跑）
USE saudade_blog;
SELECT '列已存在?' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND COLUMN_NAME = 'muted_until';

-- 1b) 加列要挂在谁后面（`AFTER` 的锚点必须真的在）。期望 `chat_quota_used` 一行。
SELECT '列序锚点' AS done, COLUMN_NAME, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND COLUMN_NAME IN ('chat_quota_used', 'status', 'token_version');

-- 1c) 账号总数（加列影响的体量；本列是即时元数据变更，不锁表）。
SELECT '账号总数' AS done, COUNT(*) AS 行数 FROM `user`;

-- 1d) flag 是否已经打过。期望**空**。
SELECT 'flag 已存在?' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'user_mute_20261002';

-- ── ② 加列 ─────────────────────────────────────────────────────────────────
-- `datetime NULL DEFAULT NULL`：显式写出 NULL 语义（迁移注释见文件头注）。
-- 不建索引：禁言的读取只有两种——"某个 uid 现在是否被禁"（主键查，取整行时顺手带出）
-- 与后端账号列表的**全表扫描**（个位数行）。没有"按到期时间扫全表解禁"这条路径
-- （禁言**不做定时任务**：判据是"现在 < muted_until"，到期自然失效，无需任何人去清）。
ALTER TABLE `user`
    ADD COLUMN `muted_until` datetime NULL DEFAULT NULL
    COMMENT '禁言到期时间（+08:00 钟面）。NULL=从未禁言；9999-12-31 23:59:59=永久。判据在 authz::is_muted'
    AFTER `chat_quota_used`;

-- ── ③ 验收 ─────────────────────────────────────────────────────────────────
-- 3a) 列与默认值：期望 1 行，`IS_NULLABLE=YES`、`COLUMN_DEFAULT` 为 NULL。
SELECT '列' AS done, ORDINAL_POSITION AS pos, COLUMN_NAME, COLUMN_TYPE,
       IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND COLUMN_NAME = 'muted_until';

-- 3b) 存量行核对：期望 被禁言行数 = 0（加列后所有人都是 NULL）。
SELECT '被禁言行数' AS done,
       SUM(CASE WHEN muted_until IS NULL THEN 1 ELSE 0 END) AS 未禁言,
       SUM(CASE WHEN muted_until IS NOT NULL THEN 1 ELSE 0 END) AS 已禁言
  FROM `user`;

-- ── ④ 打 flag ──────────────────────────────────────────────────────────────
-- 重复执行会因主键冲突报错 ⇒ 那说明已经打过，忽略即可。
INSERT INTO migration_flags (flag_name) VALUES ('user_mute_20261002');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'user_mute_20261002';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- **先回滚代码、再删列**：反了的话 `entity::user` 会 SELECT 一个不存在的列，
-- 每一次用户查询都报错（登录直接挂）。
--   ALTER TABLE `user` DROP COLUMN `muted_until`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_mute_20261002';
-- ⚠️ 删列会把**禁言记录一起删掉**（谁被禁到什么时候，取不回来）——回滚前自行留档：
--   SELECT id, username, muted_until FROM `user` WHERE muted_until IS NOT NULL;
-- =============================================================================
