USE saudade_blog;
-- =============================================================================
-- 20261001 重建被误删的测试账号 722（`agent_test_user_722`，role=user）
--
-- **为什么会有这个文件**：20261001 03:28:02，后台「临时用户」列表上的一次点击把它删了——
--   `logs/rust.log`: `2026-10-01 03:28:02.291 http method=DELETE path=/api/temp-users/722 status=200 ms=61`
-- （同一分钟内还删了 uid=15；两条都在 03:27:46 那次 `GET /api/temp-users` 之后，
--   列表页每 20 秒自动刷新 —— 是一次人工清理动作，不是自动化。今天的所有 trace 里
--   `delete_temp_user` **零命中** ⇒ 不是 agent 干的。）
--
-- 代价在 32 分钟后显形：04:00 的夜间门禁里 `GOLDEN_USER_UID=722` 的前置在位检查
-- 判 `unusable`（令牌被拒）⇒ 三条真身份用例**本轮未评估**、golden **退出码 3**：
--   `admin_write_denied_user` / `data_devices_online` / `favorite_remove_zero_write`
-- 详见 `eval/identity_preflight.py` 头注与复审单 `eval/report/review_20261001_*.md`。
--
-- ⚠️ 这份风险 `test_accounts_20260924.sql` 的头注**早就写下了**，原话：
--   「722 是 `role = 'user'` ⇒ 会出现在后台「临时用户」列表里…不至于被当游客垃圾账号删掉」
--   —— 预见是对的，但**预见写在注释里，没有变成守卫**。本文件只做重建；
--   让这件事不再无声发生是另一件事（账号删除的二次确认 / 前置检查点名到具体文件），
--   不在本文件的授权范围内。
--
-- **本文件只重建 722，不动 721**（721 未受影响：20261001 实测 `identity_preflight 721 admin`
-- → `ok 活的管理员`；全线 trace 里 uid=721 的会话在 03:2x 之后照常）。
-- 721 不在位时的重建写作 §① 的注释里，**本文件不执行**。
--
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
--
-- 口令配方与 `test_accounts_rotate_20260924.sql` 逐字相同：`SHA2(CONCAT(UUID(),UUID(),UUID()),256)`
-- —— 三个随机 UUID 拼起来的原文**从来没被任何人看到过**（不经过终端、不落任何文件、
-- 不进 shell 历史）⇒ 重建出来的号在**结构上**登录不进去。golden/探针只借 uid（自签 JWT
-- + `X-Agent-Assertion`），**不需要口令**，所以"登录不进去"不影响任何自动化。
--
-- 已知副作用（先知道再落地）：重建后 722 会**重新出现在后台「临时用户」列表里**
-- （`temp_user::list_temp_users` 按 `role = 'user'` 过滤，既有实现）⇒ 它仍然是一次误点
-- 就能删掉的目标。用户名带 `agent_test_` 前缀，是本文件之外唯一能认出来的标识。
--
-- flag: test_accounts_restore_20261001（migration_flags）

-- ── ① 现状核对：先把"现在到底是什么样"打出来（本文件的前提，不是猜测）──────
-- 期望（重建前）：722 一行都没有（id=722 计数 0）；721 在位。
-- 若 721 也不在（换库/重建的场景），§③ 的注释里有它的 INSERT。
SELECT 'before' AS phase, id, username, role, status, token_version,
       CHAR_LENGTH(password) AS pw_len,
       (password REGEXP '^[0-9a-f]{64}$')  AS looks_like_sha256,
       (password LIKE '$argon2id$%')       AS looks_like_argon2id
  FROM `user` WHERE id IN (721, 722) ORDER BY id;

-- ── ② 重建 722（幂等：行已经在时**一个字段都不改**）──────────────────────────
-- 刻意不写 `ON DUPLICATE KEY` / `REPLACE`（全仓一贯写法）：静默改掉一个已有账号
-- 是比"重建失败"更坏的结果——那一行可能已经有人在用。
-- `status` / `token_version` 走列默认值（0 / 0）：**status=0 是"正常"**，
-- 冻结是 1（见 `golden_fixture_account_20260926.sql` 的族约定）；新号没有令牌，
-- 代次从 0 起是对的。
-- nickname 留空串、avatar 留 NULL：与 721 逐字同形（`auth.rs` 的 `if nickname.is_empty()`
-- 会回落到账号名；avatar NULL = 没设过）。
INSERT INTO `user` (id, username, nickname, avatar, password, role)
SELECT 722, 'agent_test_user_722', '', NULL, SHA2(CONCAT(UUID(), UUID(), UUID()), 256), 'user'
 WHERE NOT EXISTS (SELECT 1 FROM `user` WHERE id = 722);

-- ── ③ 空库重放用的 INSERT（**本文件不执行**，仅存档）───────────────────────
--   INSERT INTO `user` (id, username, nickname, avatar, password, role) VALUES
--     (721, 'agent_test_admin_721', '', NULL, SHA2(CONCAT(UUID(), UUID(), UUID()), 256), 'admin'),
--     (722, 'agent_test_user_722',  '', NULL, SHA2(CONCAT(UUID(), UUID(), UUID()), 256), 'user');

-- ── ④ 验收：行在位、role 拼写对、口令是非空哈希（**条件写全才打 flag**）──────
-- role 是无约束 varchar ⇒ 写错不报错，账号能登录但零权限（跨语言契约：
-- Rust `authz::KNOWN_ROLES` / Python `principal.KNOWN_ROLES`）。
SELECT 'after' AS phase,
       (SELECT COUNT(*) FROM `user` WHERE id = 722 AND username = 'agent_test_user_722') AS must_be_1,
       (SELECT COUNT(*) FROM `user` WHERE id IN (721, 722) AND role IN ('admin', 'user')) AS roles_ok,
       (SELECT COUNT(*) FROM `user`
         WHERE id = 722 AND password IS NOT NULL AND password <> ''
           AND CHAR_LENGTH(password) >= 64) AS pw_ok;

INSERT INTO migration_flags (flag_name)
SELECT 'test_accounts_restore_20261001'
 WHERE (SELECT COUNT(*) FROM `user` WHERE id = 722 AND username = 'agent_test_user_722'
          AND role = 'user' AND password IS NOT NULL AND password <> ''
          AND CHAR_LENGTH(password) >= 64) = 1
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'test_accounts_restore_20261001');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'test_accounts_restore_20261001';

-- ── 跑完之后（人工，不在本文件里）──────────────────────────────────────────
-- 1. 在位检查应当转绿：`.venv/bin/python eval/identity_preflight.py 722 user`
--    期望 `{"state": "ok", "detail": "活的普通用户"}`（不再是 unusable）。
-- 2. 重跑 golden 才算数：退出码 0/1（不再是 3）。**没验之前不许把它当成"已修好"**。
--
-- ── 回滚（如需）：只删重建出来的那一行 ─────────────────────────────────────
-- DELETE FROM `user` WHERE id = 722 AND username = 'agent_test_user_722';
-- DELETE FROM migration_flags WHERE flag_name = 'test_accounts_restore_20261001';
