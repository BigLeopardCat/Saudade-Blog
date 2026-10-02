USE saudade_blog;
-- =============================================================================
-- 20260924 把 721/722 的口令轮换成**新的不可知哈希**（收口上一份文件留下的口子）
--
-- 为什么还要跑这一趟：`test_accounts_20260924.sql` 核验出的现状是——
--   · 两行口令都是 64 位十六进制 SHA-256 ⇒ 是**用 SQL 的 `SHA2()` 直接写进去的**
--     （20260917 起博客自己的口令写入路径产 Argon2id PHC，`utils.rs` 的 `hash_password`
--     ⇒ 这两行不是任何人从前台注册/改密来的）；
--   · 但**原文是否有人知道，哈希不可逆、事后无法证明**——这是那份文件如实记下的缺口。
--   721 是真 admin 角色 ⇒「有人知道的口令 + admin 身份」这条链不能靠"大概没人知道"糊过去。
--   本文件的动作就是把它掐掉：口令设为 `SHA2(CONCAT(UUID(),UUID(),UUID(),UUID()),256)`，
--   四个随机 UUID 拼起来的原文**从来没有被任何人看到过**（不经过终端、不落任何文件、
--   不进 shell 历史、不写进本文件）⇒ 此后这两个号在**结构上**登录不进去，
--   而不是靠"我们不去登它"这种约定。
--
-- 为什么是 SHA-256 而不是 Argon2id：本机没有 argon2 CLI、agent venv 也没有 argon2 模块
--   （20260921 实测），写不出 PHC 字符串；而 `verify_password` 认 `SHA2(x,256)` 这个形状
--   （Rust `utils.rs` 的旧格式兼容分支）。这两个号**不需要任何人登录** ⇒ 这里的关键是
--   **不可知**，不是抗爆破强度。（不得为"方便以后登录"而改成明文或弱口令。）
--
-- ⚠️ 副作用（如实登记，先知道再落地）：
--   · 轮换后原文不存在于任何地方 ⇒ 将来若真要登录这两个号，唯一途径是**再跑一次
--     UPDATE 换个新哈希**（本文件可重跑：重跑 = 再轮换一次，无害，只是没有意义）。
--   · 自动化链路不受影响：L3 探针走 JWT 自签 + `X-Agent-Assertion`（只取 uid，
--     Rust 每个请求自己查库拿 role）；golden 的写用例只借 uid。**都不需要口令。**
--
-- 执行前请按既有约定说清「库名 + 迁移文件」。
-- flag: test_accounts_rotate_20260924（migration_flags，勿重跑）

-- ── ① 旧哈希取进会话变量：只用来证明"确实变了"，**绝不打印** ────────────────
-- 口令哈希是凭据材料：纪律禁止把它写进终端、trace 或任何文件。下面 §③ 印的是
-- 布尔值（变了没有）与长度/形态，不是值。
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
