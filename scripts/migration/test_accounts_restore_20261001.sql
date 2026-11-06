-- flag: test_accounts_restore_20261001（migration_flags）
USE saudade_blog;
SELECT 'before' AS phase, id, username, role, status, token_version,
       CHAR_LENGTH(password) AS pw_len,
       (password REGEXP '^[0-9a-f]{64}$')  AS looks_like_sha256,
       (password LIKE '$argon2id$%')       AS looks_like_argon2id
  FROM `user` WHERE id IN (721, 722) ORDER BY id;

-- ② 重建 722（幂等：行已经在时**一个字段都不改**）
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

-- ③ 空库重放用的 INSERT（**本文件不执行**，仅存档）
--   INSERT INTO `user` (id, username, nickname, avatar, password, role) VALUES
--     (721, 'agent_test_admin_721', '', NULL, SHA2(CONCAT(UUID(), UUID(), UUID()), 256), 'admin'),
--     (722, 'agent_test_user_722',  '', NULL, SHA2(CONCAT(UUID(), UUID(), UUID()), 256), 'user');

-- ④ 验收：行在位、role 拼写对、口令是非空哈希（**条件写全才打 flag**）
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

-- 跑完之后（人工，不在本文件里）
-- 1. 在位检查应当转绿：`.venv/bin/python eval/identity_preflight.py 722 user`
--    期望 `{"state": "ok", "detail": "活的普通用户"}`（不再是 unusable）。
-- 2. 重跑 golden 才算数：退出码 0/1（不再是 3）。**没验之前不许把它当成"已修好"**。
--
-- 回滚（如需）：只删重建出来的那一行
-- DELETE FROM `user` WHERE id = 722 AND username = 'agent_test_user_722';
-- DELETE FROM migration_flags WHERE flag_name = 'test_accounts_restore_20261001';
