-- flag: superadmin_role_20260926（migration_flags，勿重跑）
USE saudade_blog;
SELECT id, username, nickname, role, status
  FROM `user` WHERE id = 1;

-- ── ② 前置闸：库里**不得已有** superadmin ────────────────────────────────────
-- 期望：must_be_0 = 0。
-- 不为 0 ⇒ 说明这个角色已经有人了（跑过一次、或有人手工改过库）。
-- **停手**：再跑一遍下面的 UPDATE 是幂等空转，但"为什么已经有"这件事必须先查清
-- （多一个超管 = 多一个你不能冻结、不能降级的账号）。
SELECT COUNT(*) AS must_be_0 FROM `user` WHERE role = 'superadmin';

-- ── ③ 提权：只动 id=1 这一行；幂等（已经是 superadmin 则影响 0 行）──────────
UPDATE `user` SET role = 'superadmin'
 WHERE id = 1 AND (role IS NULL OR role <> 'superadmin');

-- ── ④ 验收：**必须恰好 1 行**。为 0 ⇒ 库里没有 id=1（或 ① 里看到的不是它），
--         此时**不要**执行 ⑤，先查清是哪个 uid 才是博主本人。────────────────
SELECT COUNT(*) AS must_be_1 FROM `user` WHERE id = 1 AND role = 'superadmin';

-- ── ⑤ 现状快照：全站角色分布 + 谁被冻结（跑完本文件后随时可查这一条）──────────
-- 期望：role 一列里 superadmin 恰好 1 行；其余与跑之前一致。
SELECT role, COUNT(*) AS 账号数 FROM `user` GROUP BY role ORDER BY 账号数 DESC;
SELECT id, username, role, status FROM `user` WHERE status <> 0 ORDER BY id;

-- ── ⑥ 打标记：仅在 ④ 通过时写入（flag 已存在则不重复写，可安全重跑）─────────
INSERT INTO migration_flags (flag_name)
SELECT 'superadmin_role_20260926'
 WHERE (SELECT COUNT(*) FROM `user` WHERE id = 1 AND role = 'superadmin') = 1
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'superadmin_role_20260926');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'superadmin_role_20260926';

-- ── 回滚（如需）：把同一个账号降回管理员 ───────────────────────────────────
-- 顺序与上面相反：**先把 uid=1 的角色改回去、再回滚二进制**（旧二进制不认
-- superadmin，留着它就是把博主锁在后台外面；`token_version` 不动，改完角色
-- 已有的令牌照旧有效，博主不会被踢下线——除非你想让旧令牌一起失效，那就再 +1）。
--   UPDATE `user` SET role = 'admin' WHERE id = 1 AND role = 'superadmin';
--   DELETE FROM migration_flags WHERE flag_name = 'superadmin_role_20260926';
-- 注意：回滚**不会**、也不该动其它账号的角色（包括被超管改过身份的那些）——
-- 那些是各自独立的操作，要撤得一条一条撤。
