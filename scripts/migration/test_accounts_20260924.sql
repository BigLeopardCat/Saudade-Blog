USE saudade_blog;
SELECT id, username, role,
       CHAR_LENGTH(password)                        AS pw_len,
       (password REGEXP '^[0-9a-f]{64}$')           AS looks_like_sha256,
       (password LIKE '$argon2id$%')                AS looks_like_argon2id,
       (password = '' OR password IS NULL)          AS pw_empty
  FROM `user`
 WHERE id IN (721, 722)
 ORDER BY id;

-- ② role 拼写核对
-- role 是无约束 varchar ⇒ **写错不会报错**，账号能登录但零权限。
-- 只有 'admin' / 'user' 两种拼写（跨语言契约：Rust `authz::KNOWN_ROLES`）。
SELECT COUNT(*) AS must_be_2 FROM `user`
 WHERE id IN (721, 722) AND role IN ('admin', 'user');

INSERT INTO migration_flags (flag_name)
SELECT 'test_accounts_20260924'
 WHERE (SELECT COUNT(*) FROM `user`
         WHERE id IN (721, 722) AND role IN ('admin', 'user')
           AND password IS NOT NULL AND password <> '' AND CHAR_LENGTH(password) >= 64) = 2
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'test_accounts_20260924');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'test_accounts_20260924';

-- 回滚（如需）：**本文件没有新增任何账号** ⇒ 回滚只需撤 flag
-- DELETE FROM migration_flags WHERE flag_name = 'test_accounts_20260924';
-- 确要连账号一起删（会连带影响依赖它们的配置）：
-- DELETE FROM `user` WHERE id IN (721, 722) AND username IN ('agent_test_admin_721', 'agent_test_user_722');
-- （删号后记得同步撤掉依赖它们的配置：GOLDEN_ADMIN_UID / GOLDEN_USER_UID。）
