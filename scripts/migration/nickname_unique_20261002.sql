USE saudade_blog;
-- =============================================================================
-- 昵称唯一（20261002）：TRIM 归一 → 存量去重改名 → 唯一索引 + 自动改名标记列
--
-- 用户原话：「昵称也启用唯一不可重复。」
--
-- ── 为什么是**函数索引**而不是把列改成 NULL ─────────────────────────────────
-- 现状：`user.nickname` 是 `varchar(64) NOT NULL DEFAULT ''`，「空串」= 没设置过昵称
-- （`src/entity/user.rs` 里是 `pub nickname: String`，不是 Option）。要让"空串不算一个
-- 值"，两条路都行：
--   · 函数索引（本文件走的）：零代码改动、一条 DDL、回滚 = DROP INDEX；
--   · 改 NULL + `Option<String>`：`entity/user.rs` 一处改动会波及 12 个调用点，编译能抓
--     漏项，抓不到的是**"能编译但显示退化"**（例如 `unwrap_or_default()` 静默显示空串）。
--     本机既是开发机也是生产、且**跑不了测试**（最多 `cargo check`），这个风险不划算。
--
-- 索引表达式 `NULLIF(TRIM(nickname), '')`：
--   · 空串与纯空白 ⇒ NULL ⇒ 唯一索引不约束 NULL ⇒ **允许多个没设昵称的账号**（正确）；
--   · 非空 ⇒ 走唯一约束；索引**继承列的 `utf8mb4_0900_ai_ci`** ⇒ 大小写与重音不敏感
--     （`Alice` 与 `alice` 视为同一个）——这是**想要**的效果，前端提示语也照这个口径写。
--
-- ⚠️ **需要 MySQL ≥ 8.0.13**（函数索引 8.0.13 引入）。第 ① 段会打印 `VERSION()`，
--    低于 8.0.13 就**停手**，改走"列改 NULL + 显示助手"那条路（要改 12 处调用点，
--    另开一轮）。**不要**在没有版本确认的情况下直接建索引。
--
-- ── 存量重复怎么办（用户拍板：自动加后缀）──────────────────────────────────
-- 最早的注册者**保留原名**，其余改成 `原名_<id>` 并由第 ③ 段的新列
-- `nickname_auto_renamed` 置 1；个人中心据此显示一条横幅提示本人改掉。
-- 后缀带 id ⇒ 组内天然互不相同（id 是主键），且**可重复执行**：第二次跑时那些行
-- 已带后缀、不再同名，影响 0 行。
--
-- ── 顺序与中断窗口（照抄 `user_chat_quota_20260929.sql` 的纪律）────────────
--   · **本文件必须先于 Rust 上线**：`entity/user.rs` 加了 `nickname_auto_renamed`
--     之后，**每一处 `user::Entity::find*` 都会 SELECT 新列**（含 `auth_guard` 的
--     `find_by_id` 与 chat.rs 的角色查询）——列不存在不是"某页空白"，而是
--     **全部受保护路由 500**。
--   · 反过来（先上 Rust 再跑本文件）也不行：新代码会 SELECT 一个不存在的列。
--   · ADD COLUMN 没有 IF NOT EXISTS，重复执行会报 `Duplicate column name` ⇒
--     **那说明已经应用过了，停手即可**，不会改坏数据。
--   · 不锁表：`user` 是个位数行；ADD COLUMN 带默认值是即时元数据变更；建索引是
--     秒级操作。
--
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- flag: nickname_unique_20261002（migration_flags，勿重跑）
-- =============================================================================

-- ── ① 核对（跑之前先看这三条）──────────────────────────────────────────────
-- 判据全用**与索引同款**的表达式（NULLIF + TRIM + 列的 ai_ci 排序规则），
-- 这样"这里看到 0 组"与"索引建得上"是同一件事，不是两次不同的猜测。

-- 1a) 版本。**必须 ≥ 8.0.13**，否则下面的函数索引建不出来。
SELECT VERSION() AS mysql_version;

-- 1b) 存量重复组。期望：见几行就是有几组重名要处理（全新站点应为空）。
--     分组口径 = 索引口径：空串/纯空白归为 NULL（**不参与唯一性**），大小写不敏感。
--     `IS NOT NULL` 这个条件不能少：没设昵称的账号会一起落进 NULL 这一组，
--     少了它"三个人都没设昵称"会被报成一个重名组，执行者据此白白停手。
SELECT '重复组' AS done,
       NULLIF(TRIM(nickname), '') AS 归一组,
       COUNT(*)                   AS 行数,
       GROUP_CONCAT(id ORDER BY id) AS ids,
       GROUP_CONCAT(username ORDER BY id) AS 账号
  FROM `user`
 GROUP BY NULLIF(TRIM(nickname), '')
HAVING COUNT(*) > 1 AND NULLIF(TRIM(nickname), '') IS NOT NULL;

-- 1c) 空/空白昵称现状。这些行**不受**唯一约束（NULL 不进唯一索引），
--     这里只是让执行者知道有多少账号还没设昵称。
SELECT '空昵称' AS done, COUNT(*) AS 行数
  FROM `user` WHERE NULLIF(TRIM(nickname), '') IS NULL;

-- ── ② 空白归一：先把 `' '` 与 `''`、`' a'` 与 `'a'` 拉平成同一种形态 ─────────
-- 不做这一步的话：`' '` 与 `''` 会各自成组（TRIM 后都是空 ⇒ 其实都归 NULL，OK），
-- 但 `' a'` 与 `'a'` 是两个不同的非空值 ⇒ **逃过唯一性**，与"昵称不可重复"的意图相悖。
-- 幂等：已经 TRIM 过的行不满足 `nickname <> TRIM(nickname)`，影响 0 行。
UPDATE `user` SET nickname = TRIM(nickname) WHERE nickname <> TRIM(nickname);

-- ── ③ 自动改名标记列（个人中心的横幅判据）──────────────────────────────────
-- 1 = 这个昵称是**迁移自动改的**（原名与别人重复，系统给它加了 `_<id>` 后缀），
-- 本人改一次昵称就会被 `update_profile` 清 0。存量行默认 0 ⇒ 正常情况下没人看到横幅。
ALTER TABLE `user`
    ADD COLUMN `nickname_auto_renamed` tinyint(1) NOT NULL DEFAULT 0
        COMMENT '昵称是否由迁移自动加后缀去重（1=需要提示本人改名；本人改过即清 0）'
        AFTER `nickname`;

-- ── ④ 存量去重：每组保留 MIN(id)，其余改名为 `原名_<id>` 并置标记 ────────────
-- 窗口函数 `ROW_NUMBER() OVER (PARTITION BY nickname ORDER BY id)` 在**改之前**
-- 对全表求值（派生表被物化，UPDATE 的赋值不会影响本次编号）——所以"谁保留原名"
-- 是确定的：注册最早的那个。
-- `LEFT(nickname, 64 - CHAR_LENGTH('_' || id))` 保证结果**不超过 varchar(64)**：
-- 原名本来就 ≤64，截到"留得下后缀"的长度再拼，长昵称也不会被截断报错。
-- 幂等：第二次跑时 rn>1 的行已带后缀、不再同名，影响 0 行。
UPDATE `user` AS u
  JOIN (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY nickname ORDER BY id) AS rn
        FROM `user`
  ) AS d ON d.id = u.id AND d.rn > 1
   SET u.nickname = CONCAT(LEFT(u.nickname, 64 - CHAR_LENGTH(CONCAT('_', u.id))), '_', u.id),
       u.nickname_auto_renamed = 1;

-- ── ⑤ 建索引**之前**的最后一道核对：仍必须为 0 组 ──────────────────────────
-- 为什么可能不为 0：后缀会撞上一条**本来就叫 `X_7`** 的合法昵称（那个人不是重名者，
-- 所以第 ④ 段没动它）。这种情况**就地处理，不要带着重复去建索引**（索引会建失败，
-- 而失败信息只说 duplicate entry，看不出是哪一组、为什么）。
--   · 再跑一次第 ④ 段即可：这一次 `X_7` 那一组有了两条，早的那条留下、晚的再被加后缀，
--     后缀带 id ⇒ 组内必然各不相同，一两轮就收敛；
--   · 跑两三次仍不为 0 ⇒ **停手人工看**（把下面这行结果留档再判断）。
SELECT '重复组（建索引前必须为空）' AS done,
       NULLIF(TRIM(nickname), '') AS 归一组,
       COUNT(*)                   AS 行数,
       GROUP_CONCAT(id ORDER BY id) AS ids,
       GROUP_CONCAT(username ORDER BY id) AS 账号
  FROM `user`
 GROUP BY NULLIF(TRIM(nickname), '')
HAVING COUNT(*) > 1 AND NULLIF(TRIM(nickname), '') IS NOT NULL;

-- ── ⑥ 建唯一索引 ───────────────────────────────────────────────────────────
-- 函数索引：表达式外**必须再套一层括号**（`((expr))`），单层会被当成列名。
-- 唯一性只作用在非空昵称上（NULL 不进唯一索引）。
ALTER TABLE `user`
    ADD UNIQUE KEY `uk_user_nickname` ((NULLIF(TRIM(nickname), '')));

-- ── ⑦ 验收 + 打 flag ───────────────────────────────────────────────────────
-- 7a) 索引在：期望恰好 1 行，`非唯一` = 0，表达式与上面那条逐字一致。
SELECT '索引已存在' AS done, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, EXPRESSION
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND INDEX_NAME = 'uk_user_nickname';

-- 7b) 全表昵称分布（三个数并排看）：未设昵称的账号**不受**唯一约束，是正常态，
--     不是缺口；`被自动改名的行数` 就是会看到横幅提示的人数。
SELECT '全表核对' AS done,
       COUNT(*)                               AS 账号总数,
       SUM(NULLIF(TRIM(nickname), '') IS NULL) AS 未设昵称,
       SUM(nickname_auto_renamed = 1)          AS 被自动改名的行数
  FROM `user`;

-- 7c) 重名组数：**必须为 0**（与 1b / ⑤ 同一条判据，含 IS NOT NULL 那一半）。
--     为 0 = 索引确实在按预期约束；不为 0 ⇒ 索引没建成，回到 ⑥ 看报错。
SELECT '重名组数（必须 0）' AS done, COUNT(*) AS 重名组数 FROM (
    SELECT 1 FROM `user`
     GROUP BY NULLIF(TRIM(nickname), '')
    HAVING COUNT(*) > 1 AND NULLIF(TRIM(nickname), '') IS NOT NULL
) AS dup;

-- 7d) 标记（重复执行会因主键/唯一键报错 ⇒ 那说明已经打过，忽略即可）
INSERT INTO migration_flags (flag_name) VALUES ('nickname_unique_20261002');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'nickname_unique_20261002';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- 顺序与正向相反：
--   ALTER TABLE `user` DROP INDEX `uk_user_nickname`;
--   ALTER TABLE `user` DROP COLUMN `nickname_auto_renamed`;
--   DELETE FROM migration_flags WHERE flag_name = 'nickname_unique_20261002';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码一律按这一列查 user 表，
--    列没了就是全部受保护路由 500（与"没跑迁移就推送"同一种破坏）。
-- ⚠️ 回滚**不会**把已经加过后缀的昵称改回去——原名已被覆盖，本文件不保留原值副本
--    （改名前请自行 `SELECT id, username, nickname FROM user` 留一份，如需）。
--    但 `nickname_auto_renamed = 1` 这一列留档了"哪些是被系统改的"，本人仍可自行改回。
-- =============================================================================
