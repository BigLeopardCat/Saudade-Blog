USE saudade_blog;
SET @zako := 'REPLACE_ME';

-- ── ① 核对：这一行现在长什么样（role 应为非 zako 值）──────────────────────
SELECT id, username, nickname, role FROM `user` WHERE username = @zako;

-- ── ② 授予：只动这一行；幂等（已经是 zako 则影响 0 行）────────────────────
UPDATE `user` SET role = 'zako'
 WHERE username = @zako AND (role IS NULL OR role <> 'zako');

-- ── ③ 验收：**必须恰好 1 行**。为 0 ⇒ ①里的名字库里没有（口令打错/没建号），
--         此时**不要**继续，先去建号；为 1 才执行 ④。────────────────────
SELECT COUNT(*) AS must_be_1 FROM `user` WHERE username = @zako AND role = 'zako';

-- ── ④ 打标记：仅在 ③ 通过时写入（flag 已存在则不重复写，可安全重跑）───────
INSERT INTO migration_flags (flag_name)
SELECT 'zako_role_20261002'
 WHERE (SELECT COUNT(*) FROM `user` WHERE username = @zako AND role = 'zako') = 1
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'zako_role_20261002');

-- ── 回滚（如需）：把同一个账号降回普通访客 ────────────────────────────────
-- UPDATE `user` SET role = 'user' WHERE username = @zako;
-- DELETE FROM migration_flags WHERE flag_name = 'zako_role_20261002';
