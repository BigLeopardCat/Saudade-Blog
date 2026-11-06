-- flag: test_accounts_rotate_20260924（migration_flags，勿重跑）
USE saudade_blog;
SET @old721 := (SELECT password FROM `user` WHERE id = 721 AND username = 'agent_test_admin_721');
SET @old722 := (SELECT password FROM `user` WHERE id = 722 AND username = 'agent_test_user_722');

-- ── ② 轮换：WHERE 带用户名 ⇒ 行不是预期那两行时**一行都不改**（③ 会响亮地不通过）──
UPDATE `user`
   SET password = SHA2(CONCAT(UUID(), UUID(), UUID(), UUID()), 256)
 WHERE id = 721 AND username = 'agent_test_admin_721';
UPDATE `user`
   SET password = SHA2(CONCAT(UUID(), UUID(), UUID(), UUID()), 256)
 WHERE id = 722 AND username = 'agent_test_user_722';

-- ── ③ 验收：变了 + 形态合法 + 非空 ──────────────────────────────────────────
-- 期望两行：pw_changed=1、pw_len=64、looks_like_sha256=1、pw_empty=0。
-- ⚠️ pw_changed=0 或为 NULL ⇒ 那一行**没被改**（行不在 / 用户名不匹配 / @old 取不到）
--    ⇒ 停下来看清楚，**不要**把它当成功。
SELECT id, username, role,
       CASE WHEN id = 721 THEN (password <> @old721) ELSE (password <> @old722) END AS pw_changed,
       CHAR_LENGTH(password)                    AS pw_len,
       (password REGEXP '^[0-9a-f]{64}$')       AS looks_like_sha256,
       (password = '' OR password IS NULL)      AS pw_empty
  FROM `user`
 WHERE id IN (721, 722)
 ORDER BY id;

-- ── ④ 打标记：仅在 ③ 的两个条件都成立时写入（flag = "已轮换"，不是"文件被打开过"）──
INSERT INTO migration_flags (flag_name)
SELECT 'test_accounts_rotate_20260924'
 WHERE (SELECT COUNT(*) FROM `user`
         WHERE id = 721 AND username = 'agent_test_admin_721'
           AND password <> @old721 AND password REGEXP '^[0-9a-f]{64}$') = 1
   AND (SELECT COUNT(*) FROM `user`
         WHERE id = 722 AND username = 'agent_test_user_722'
           AND password <> @old722 AND password REGEXP '^[0-9a-f]{64}$') = 1
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'test_accounts_rotate_20260924');

-- 回读（期望 1 行；列名是 applied_at）
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'test_accounts_rotate_20260924';

-- ── 回滚：口令轮换**在语义上不可回滚**（旧哈希没人存过）────────────────────
-- 要撤销只有一条路——再轮换一个新哈希（重跑本文件即可），**不是**恢复旧值。
-- flag 可撤：DELETE FROM migration_flags WHERE flag_name = 'test_accounts_rotate_20260924';
