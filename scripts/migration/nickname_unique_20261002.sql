-- flag: nickname_unique_20261002（migration_flags，勿重跑）
USE saudade_blog;
SELECT VERSION() AS mysql_version;

SELECT '重复组' AS done,
       NULLIF(TRIM(nickname), '') AS 归一组,
       COUNT(*)                   AS 行数,
       GROUP_CONCAT(id ORDER BY id) AS ids,
       GROUP_CONCAT(username ORDER BY id) AS 账号
  FROM `user`
 GROUP BY 归一组
HAVING COUNT(*) > 1 AND 归一组 IS NOT NULL;

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

UPDATE `user` AS u
  JOIN (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY NULLIF(TRIM(nickname), '') ORDER BY id) AS rn
        FROM `user`
       WHERE NULLIF(TRIM(nickname), '') IS NOT NULL
  ) AS d ON d.id = u.id AND d.rn > 1
   SET u.nickname = CONCAT(LEFT(TRIM(u.nickname), 64 - CHAR_LENGTH(CONCAT('_', u.id))), '_', u.id),
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
 GROUP BY 归一组
HAVING COUNT(*) > 1 AND 归一组 IS NOT NULL;

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
    SELECT NULLIF(TRIM(nickname), '') AS 归一组
      FROM `user`
     GROUP BY 归一组
    HAVING COUNT(*) > 1 AND 归一组 IS NOT NULL
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
