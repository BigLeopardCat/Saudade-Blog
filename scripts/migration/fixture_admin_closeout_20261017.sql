-- =============================================================================
-- 20261017 收口残留夹具管理员 721（口令轮换 + 降权）
--
-- ## 为什么还要跑这一趟
--
-- 721（`agent_test_admin_721`）是 golden 的**真身份通道**用的那个 admin 号
-- （`eval/run_golden.py` 的跑法写着 `GOLDEN_ADMIN_UID=721 GOLDEN_ALLOW_REAL_WRITE=1`，
-- 夜跑脚本同值，见 `saudade-blog-agent/scripts/nightly_regression.sh:127`）。
-- 它身上有两条各自独立的问题，本文件一条一条收掉。
--
-- ### A. 口令哈希（`test_accounts_20260924.sql` 留下的那一格）
-- 那份文件核验出 721/722 是 64 位裸 SHA-256，并如实记下了缺口：
-- **哈希不可逆 ⇒ "原文是不是某个有人知道的短串"事后无法证明**，它不替这两行开脱。
-- 它自己指了出路（把口令换成新的不可知哈希），`test_accounts_rotate_20260924.sql`
-- 也确实跑过了（flag 在 `migration_flags`，2026-09-24 03:15:28），配方是
-- `SHA2(CONCAT(UUID(),UUID(),UUID(),UUID()),256)`——四个随机 UUID 的拼接，原文
-- 从来没有被任何人看到过（不经过终端、不落文件、不进 shell 历史）。
--
-- 但那条链上还剩一环**没有闭合**：那个 flag 是**条件写**的，它钉的是
-- 「721 那一行真的变了」（`password <> @old721 AND password REGEXP '^[0-9a-f]{64}$'`），
-- 钉的不是「变成了 UUID 拼接」。换言之，它能排除"轮换脚本没跑"，排除不了
-- "有人在轮换之后又把口令改成一个有人知道的值"。本文件 §② 把这一格直接焊死：
-- **不管现在是什么，重新轮换一次**，此后 721/722 的口令哈希有确定来历。
--
-- ### B. 角色（本批新提出）
-- 口令这一半收掉之后，"有人知道的口令 + admin 身份"这条链就断了。但**另一半还在**：
-- 它是一个 `role='admin'` 的残留夹具，而 `middleware.rs:82` 的准入判据是
-- **从库里现读 role、不信令牌 claims**（原注释：「从数据库校验用户角色，而非信任
-- JWT 中的 role」）⇒ 只要库里是 admin，任何持有 721 有效令牌的人就是管理员。
--
-- 更关键的是**它被一个会真写生产数据的自动化用着**：`GOLDEN_ALLOW_REAL_WRITE=1`。
-- `test_accounts_20260924.sql` 的纪律原话是「不要把它们加进任何会真写业务数据的
-- 自动化」——这一条**至今没有照办**。降权之后，golden 的身份通道必须另找 admin
-- （**那是另一笔改动，在 agent 仓 `scripts/nightly_regression.sh`，不在本文件里**，
-- 见文末《本文件之外》）。
--
-- ## 本文件做什么
--   ① 核验现状（跑之前先看清）
--   ② A：把 721/722 的口令轮换成新的不可知哈希
--   ② B：把 721 的 role 由 admin 降为 user
--   ③ 验收：变了 + 形态合法 + 降权生效
--   ④ flag（**条件写**：三件事都成立才登记）
--   ⑤ 回滚（两段各自独立）
--
-- ## 幂等
-- 两条 UPDATE 的 WHERE 都锁 `id` + `username`，行不在/用户名不匹配 ⇒ 影响 0 行，
-- §③ 会响亮地不通过（而不是静默"成功"）。重复执行会**再轮换一次**口令（新 UUID，
-- 仍然不可知）⇒ 幂等的是"结果的性质"，不是"字节相同"。这是有意的：这一格的目的是
-- 「有确定来历」，多跑一次不会让它变差。
--
-- ## 点名串（跑之前需要主人显式授权）
--   mysql,saudade_blog,scripts/migration/fixture_admin_closeout_20261017.sql,迁移允许
-- =============================================================================

-- ── ① 现状核验（**只读**；跑之前看，跑之后对照）────────────────────────────
-- 期望（20261017 实测）：721 = admin / 64 位裸 SHA-256；722 = user / 64 位裸 SHA-256。
SELECT id, username, role, status, token_version,
       CHAR_LENGTH(password)                AS pw_len,
       (password REGEXP '^[0-9a-f]{64}$')   AS looks_like_sha256,
       (password LIKE '$argon2id$%')        AS looks_like_argon2id,
       (password = '' OR password IS NULL)  AS pw_empty
  FROM `user`
 WHERE id IN (721, 722)
 ORDER BY id;

-- 把轮换前的哈希抄进变量（§④ 的 flag 判据要用它证明"真的变了"）。
-- **它不是凭据**：这是一枚单向哈希，抄下来只为了比较，不构成任何登录能力。
SET @old721 = (SELECT password FROM `user` WHERE id = 721 AND username = 'agent_test_admin_721');
SET @old722 = (SELECT password FROM `user` WHERE id = 722 AND username = 'agent_test_user_722');

-- 降权前的角色也要抄（§④ 要用它证明"真的降了"）。
SET @old_role721 = (SELECT role FROM `user` WHERE id = 721 AND username = 'agent_test_admin_721');

-- ⚠️ 前置断言：两行都得在。@old721 / @old722 为 NULL ⇒ 下面两条 UPDATE 一行都不改、
--    §③ 会报错，但**先把话说在前面**比事后查便宜。期望：两行，值为 1。
SELECT
  (@old721 IS NOT NULL) AS row721_present,
  (@old722 IS NOT NULL) AS row722_present,
  (@old_role721 = 'admin') AS role721_is_admin;

-- ── ② A：口令轮换（配方与 `test_accounts_rotate_20260924.sql` **逐字相同**）──
-- 四个随机 UUID 拼起来的原文**从来没有被任何人看到过**：不经过终端、不落任何文件、
-- 不进 shell 历史、不写进本文件。此后这两行在**结构上**登录不进去
-- （`utils.rs::verify_password` 会拿输入算 SHA-256 去比对，而原文不可知 ⇒ 永不相等）。
--
-- WHERE 带用户名：行不是预期那两行时**一行都不改**，§③ 会响亮地不通过。
UPDATE `user`
   SET password = SHA2(CONCAT(UUID(), UUID(), UUID(), UUID()), 256)
 WHERE id = 721 AND username = 'agent_test_admin_721';

UPDATE `user`
   SET password = SHA2(CONCAT(UUID(), UUID(), UUID(), UUID()), 256)
 WHERE id = 722 AND username = 'agent_test_user_722';

-- ── ② B：降权（admin → user）───────────────────────────────────────────────
-- **为什么降到 user 而不是删号**：删号会让 `GOLDEN_ADMIN_UID` 指向一个不存在的行，
-- 探针报的是"查无此人"而不是"身份不对"，那是另一种噪音。降到 user 之后：
--   · `authz::can_access_console('user')` = false ⇒ `auth_guard` 当场 403
--     （判据从库里现读，所以**不需要**等令牌过期或 bump `token_version`）；
--   · `authz::is_listable_role('user')` = true ⇒ 它**会**出现在后台「临时用户」列表里，
--     也就**变得可以被 `delete_temp_user` 删掉**了（`list_temp_users` 只收 role=user）。
--     这是有意的：这个号本来就是待清理的残留，降权是把它挪进"清理得掉"的那一档。
--     ⚠️ 但代价是它和 722 一样暴露在那个列表上——722 在 20261001 03:28:02 就是这样
--     被一次人工清理误删的（`logs/rust.log` 那次 `DELETE /api/temp-users/722`）。
--     列表页每 20 秒自动刷新，**别在后台开着这个列表页顺手清**。
--   · 它挂着的 `talk` / `dashboard_todo` / `user_notification` **不受影响**（按 uid 关联）。
UPDATE `user`
   SET role = 'user'
 WHERE id = 721 AND username = 'agent_test_admin_721' AND role = 'admin';

-- ── ③ 验收：三件事都必须成立 ────────────────────────────────────────────────
-- 期望一行：pw_changed721=1、pw_changed722=1、pw_len=64、looks_like_sha256=1、
--           pw_empty=0、role_now=user、role_changed=1。
-- ⚠️ 任一为 0/NULL ⇒ 那一件事**没做成**（行不在 / 用户名不匹配 / @old 取不到），
--    按"本文件没跑成"处理，别把 flag 当成功证据。
SELECT
  u.id,
  u.username,
  u.role                                                              AS role_now,
  (u.password <> @old721)                                             AS pw_changed721,
  (u.password <> @old722)                                             AS pw_changed722,
  CHAR_LENGTH(u.password)                                             AS pw_len,
  (u.password REGEXP '^[0-9a-f]{64}$')                                AS looks_like_sha256,
  (u.password LIKE '$argon2id$%')                                     AS looks_like_argon2id,
  (u.password = '' OR u.password IS NULL)                             AS pw_empty,
  (u.password NOT IN (COALESCE(@old721, ''), COALESCE(@old722, '')))  AS differs_from_both_old
  FROM `user` u
 WHERE u.id IN (721, 722)
 ORDER BY u.id;

-- 降权那一条单独看一眼（上面那张表里 721 的 role_now 应为 user）。
SELECT id, username, role, (@old_role721 = 'admin' AND role = 'user') AS role_changed
  FROM `user` WHERE id = 721;

-- 确认没有把别人误伤：全站 admin/superadmin 应当**恰好少掉 721 这一个**。
-- 期望（20261017 实测，降权前）：1 sora(superadmin) / 5 niuniu / 6 jingbao / 721 / 748 demo_admin
--                            降权后：1 / 5 / 6 / 748 —— **721 不在这一列里**。
SELECT id, username, role FROM `user`
 WHERE role IN ('admin', 'superadmin') ORDER BY id;

-- ── ④ flag：**三件事都成立才登记** ─────────────────────────────────────────
-- 条件写全（同 `test_accounts_rotate_20260924.sql` 的写法）：两行口令都变了、形状合法、
-- 且 721 的 role 真的成了 user。任一不满足 ⇒ 不写 flag（flag 的含义是"这次收口做成了"，
-- 不是"本文件被打开过"）。
INSERT INTO migration_flags (flag_name)
SELECT 'fixture_admin_closeout_20261017'
 WHERE (SELECT COUNT(*) FROM `user`
         WHERE id = 721 AND username = 'agent_test_admin_721'
           AND password <> @old721 AND password REGEXP '^[0-9a-f]{64}$'
           AND role = 'user') = 1
   AND (SELECT COUNT(*) FROM `user`
         WHERE id = 722 AND username = 'agent_test_user_722'
           AND password <> @old722 AND password REGEXP '^[0-9a-f]{64}$') = 1
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'fixture_admin_closeout_20261017');

-- 回读 flag（期望 1 行；列名是 applied_at——`created_at` 不存在，20260924 首跑就撞在这）
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'fixture_admin_closeout_20261017';

-- ── ⑤ 回滚（两段**各自独立**，不要一起撤）───────────────────────────────────
-- ⚠️ 口令**回滚不了**：@old721/@old722 是旧哈希，把哈希写回去不会恢复任何东西
--    （原文本来就不可知）⇒ 这一段的"回滚"在语义上不存在，只能**再轮换一次**
--    （重复跑 §② A 即可，结果仍是"有确定来历的不可知哈希"）。
--
-- B 的降权可以精确回滚（前提是你真的要把 admin 还给一个残留夹具）：
--   UPDATE `user` SET role = 'admin'
--    WHERE id = 721 AND username = 'agent_test_admin_721' AND role = 'user';
--
-- flag 撤销：
--   DELETE FROM migration_flags WHERE flag_name = 'fixture_admin_closeout_20261017';
--
-- 连账号一起删（**本文件不做**，留作后续清理；降权后它已经在可删的那一档里了）：
--   DELETE FROM `user` WHERE id = 721 AND username = 'agent_test_admin_721';
--   DELETE FROM `user` WHERE id = 722 AND username = 'agent_test_user_722';
--   （删号前先看它挂着什么：talk / dashboard_todo / note_comment / user_notification
--     都是按 uid 关联的，删号会留下悬空引用。721/722 那两个号上没有 note_comment。）

-- =============================================================================
-- 本文件之外（跑完必须跟着做，否则 golden 的身份通道会 403）
-- =============================================================================
-- 降权之后 `auth_guard` 会拒绝 721（判据从库里现读）⇒ 下列两处**必须**改指另一个
-- 真 admin，否则 golden 的管理员域用例与身份前置探针会全线红：
--
--   ① `saudade-blog-agent/scripts/nightly_regression.sh:127`
--        export GOLDEN_ADMIN_UID=721      →  改成另一个 admin 的 uid
--   ② `saudade-blog-agent/eval/run_golden.py` 里文档化的跑法（第 41、3000 行附近的注释）
--        GOLDEN_ADMIN_UID=721 …           →  同步改
--
-- **候选必须自己先验**：改指之前确认那个号的 `role` 确实是 admin（`middleware.rs` 现读
-- 库里的 role），并且它的口令形态是**干净的**（Argon2id 或已知不可知的哈希）——
-- 否则只是把同一格问题搬到另一个号上。20261017 的 admin 全名单见 §③ 最后那条 SELECT。
--
-- ⚠️ 这一条**不在本文件的授权范围内**（它是 agent 仓的代码改动，不是库写操作），
--    本文件跑完之后**立刻**做，别让 golden 带着一个 403 的身份过夜。
-- =============================================================================
