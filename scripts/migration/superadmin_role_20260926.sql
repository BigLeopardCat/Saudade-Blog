USE memory_blog;
-- =============================================================================
-- 超级管理员角色落库（20260926）：把博主本人的账号（uid = 1）提为 superadmin
--
-- 需求原话（第 5 项）：「把我的UID用户改成超级管理员，超级管理员账号密码不显示在
-- 后台，超级管理员可以变更用户权限身份，管理员之间不可互相冻结。超级管理员有最高权限。」
-- 本文件只做**中间那一半**——库里那个角色的名字。旁边那些判据全在代码里：
--   · `src/authz.rs`：取值域多一个 superadmin、`can_access_console` 认它、
--     冻结/改身份两张策略表（超管谁都不能动、管理员之间不可互冻）；
--   · `src/routes/temp_user.rs`：账号列表不列超管（列表本来就不回密码，如今整行都不回）
--     ⇒「超级管理员账号密码不显示在后台」；
--   · agent 侧同批跟进（角色名跨语言同名同义），见任务一第 5 节。
--
-- ⚠️⚠️ **执行顺序与常规相反：先上代码、再跑本文件。** ⚠️⚠️
--   常规纪律是「迁移没跑不许 push」，这一条是唯一的例外，理由是判据的方向：
--     · 先改库、后部署 ⇒ 旧二进制不认识 `superadmin`，`is_known_role` 判假、
--       `can_access_console` 判假 ⇒ **uid=1 当场进不去后台**（而且旧代码只会
--       回一句"无权限"，看日志都未必想到是角色名太新）；
--     · 先部署、后改库 ⇒ 新二进制认识 `superadmin`，库里还是 `admin`，
--       一切照旧、没有任何坏处。
--   所以顺序是：父仓 A+B 上线 → agent 仓 F 批 push **并 restart** → 再跑本文件。
--   （agent 那半不能漏：agent 侧角色表不认这个名字时，博主在 agent 眼里是"未登记
--   角色" ⇒ 管理助手零权限 + 拿访客的人设。父仓上线、agent 没重启的那个窗口里，
--   博主**自己**的管理助手是不能用的。）
--
-- 锚点为什么是 id 而不是用户名：本次已点名 uid（1）。用 id 少一层"名字打错就静默
-- 影响 0 行"的风险，而且 ① 那一步会先把这一行的用户名打出来给人眼确认一次。
--
-- 只改一行：不批量、不建角色表、不动其它账号。**界面上加不出第二个超管**
-- （`authz::is_assignable_role` 把 superadmin 排除在可指派范围外）——要再加一个
-- 超管就是再来一个这样的文件。
--
-- flag: superadmin_role_20260926（migration_flags，勿重跑）
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- =============================================================================

-- ── ① 核对：uid=1 现在长什么样（人眼确认"这确实是博主本人那个账号"）──────────
-- 期望：1 行，role 为 admin 或 user；username 就是你登录后台用的那个。
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
