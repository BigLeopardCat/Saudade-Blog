USE saudade_blog;
-- =============================================================================
-- 内容风控与禁言（20261002）：`user.muted_until` —— 纯加列，一行 DDL
--
-- 需求原文：「监控异常评论和留言用户，短期内大量评论留言会被风控，增加禁言机制，
-- 同时禁言权限提供给 agent。」
--
-- ── 禁言是什么、不是什么（与"冻结"的分野）────────────────────────────────
-- 站内已有 `user.status`（冻结，20260926）：它的语义是**踢下线 + 作废令牌**——被冻的
-- 账号登不进来。风控要的却不是这个：短期刷屏的人应当**立刻发不出内容，但仍然能
-- 登录、能看文章、能跟 agent 说话**（误伤一人 vs 封掉一个访客，代价差得远）。
-- 所以禁言是**另一列、另一条判据、另一处拦截点**：
--   · 判据只加在**写入 handler 的入口**（发评论 / 发留言），
--     **绝不改 `middleware.rs` / `authz::check_token`** —— 那两处回答的是"这个令牌还
--     算不算数"，禁言不改变它；
--   · **禁言绝不 bump `token_version`**（与冻结正相反）：被禁言的人本来就该留在登录态里。
--
-- ── 「未禁言」与「永久」必须可区分 ────────────────────────────────────────
-- `muted_until` NULL = **从未禁言**；`9999-12-31 23:59:59` = **永久禁言**
-- （常量 `authz::MUTE_FOREVER`）。**不用 NULL 表永久**：那样"从未禁言"与"永久禁言"
-- 在库里长得一模一样，后台列表、幂等判定（"现在就是禁言中 ⇒ 不重复弹卡"）与通知文案
-- 全都分不出来——而这三处正是最需要分清"要不要再操作一次"的地方。
--
-- ── 存量行不需要回填 ──────────────────────────────────────────────────────
-- 加列之后所有既有账号都是 NULL = 未禁言，**正是正确语义**（风控是新增能力，
-- 历史上没有人被禁言过）。所以本文件没有 UPDATE，也不需要"迁移期宽限"。
--
-- ── ⚠️ 硬顺序：本文件必须**先跑**，Rust 代码**后 push** ─────────────────────
-- `entity::user` 一旦多一列，sea-orm 生成的 SELECT 会**显式列出它**
-- （不是 `SELECT *`）⇒ 列不存在就是**每一次用户查询都报错**：登录、个人中心、
-- 留言列表、后台账号页全挂。这与纯数据的 `zako_role_20261002.sql` 不同，
-- 与 `nickname_unique_20261002.sql`（同族加列）是同一条纪律。
-- 反过来说：**先跑本文件、隔天再推代码是完全安全的**（多一列 nullable 不影响旧代码）。
--
-- 执行前请按既定约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- flag: user_mute_20261002（migration_flags，勿重跑）
-- =============================================================================

-- ── ① 核对（跑之前先看这三条）──────────────────────────────────────────────

-- 1a) 列是否已经存在。期望**空**（`ADD COLUMN` 没有 IF NOT EXISTS，重复执行报
--     `Duplicate column name`——那无所谓，但会让你误以为这次才加）。
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
