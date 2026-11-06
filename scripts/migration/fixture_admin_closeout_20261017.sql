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

-- ② A：口令轮换（配方与 `test_accounts_rotate_20260924.sql` **逐字相同**）
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

UPDATE `user`
   SET role = 'user'
 WHERE id = 721 AND username = 'agent_test_admin_721' AND role = 'admin';

-- ③ 验收：三件事都必须成立
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

SELECT id, username, role FROM `user`
 WHERE role IN ('admin', 'superadmin') ORDER BY id;

-- ④ flag：**三件事都成立才登记**
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

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'fixture_admin_closeout_20261017';
