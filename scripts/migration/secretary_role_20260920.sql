USE saudade_blog;
-- 20260920 秘书角色落库（agent 侧秘书框架的前置需求 ①）。
-- 背景：agent 侧身份/权限模型（Principal + scope 声明表 + 唯一判据）已落地，Rust 侧
-- `src/authz.rs` 声明了 `user.role` 的取值域 {admin, user, secretary}。库里今天只有
-- admin / user 两种取值——没有一行是 secretary，所以"秘书"这条路径一次也没被真实数据
-- 走过。本迁移把**一个**账号提升为 secretary（代博主读他人数据、代写的载体）。
--
-- 只改一行，不做批量、不建角色表、不动任何现有账号的角色：
--   admin    = 博主本人（后台全权，auth_guard 唯一准入角色）
--   user     = 访客/体验号（本迁移不动）
--   secretary= 提升后的这一个账号（进不了后台管理面——`authz::can_access_console`
--              只认 admin，已由 Rust 侧单测锁死）
--
-- 执行顺序（**先建号、再提权**）：
--   ① 后台「临时用户」面板用 `POST /api/temp-users` 建一个秘书账号（该接口用
--      Argon2id 落密码，属正规路径；本迁移不插密码哈希，也就不需要把口令写进 SQL）；
--   ② 把这个账号的用户名填进下面的 @secretary；
--   ③ 逐段执行（① 看、② 改、③ 验收、④ 打标记）。
--
-- ⚠️ 提权后该账号**不再出现在后台「临时用户」列表里**：`temp_user::list_temp_users`
-- 按 `role = 'user'` 过滤（这是既有实现的事实，不是本迁移引入的）。要改密/删除这个
-- 账号就得走 SQL 或另开一个后台入口——上线前想清楚这一点（秘书账号本就该由博主
-- 自己管，不在"临时用户"语义里）。

-- ── 前置：目标账号名（须与库里实际用户名**完全一致**，大小写敏感）──────────
-- 不存在也不会报错（下一步影响 0 行、③ 的 must_be_1 会变成 0）——所以 ③ 必须看。
SET @secretary := 'REPLACE_ME';

-- ── ① 核对：这一行现在长什么样（role 应为 'user' 或其它非 secretary 值）────
SELECT id, username, nickname, role FROM `user` WHERE username = @secretary;

-- ── ② 授予：只动这一行；幂等（已经是 secretary 则影响 0 行）───────────────
UPDATE `user` SET role = 'secretary'
 WHERE username = @secretary AND (role IS NULL OR role <> 'secretary');

-- ── ③ 验收：**必须恰好 1 行**。为 0 ⇒ ①里的名字库里没有（口令打错/没建号），
--         此时**不要**继续，先去建号；为 1 才执行 ④。────────────────────
SELECT COUNT(*) AS must_be_1 FROM `user` WHERE username = @secretary AND role = 'secretary';

-- ── ④ 打标记：仅在 ③ 通过时写入（flag 已存在则不重复写，可安全重跑）───────
INSERT INTO migration_flags (flag_name)
SELECT 'secretary_role_20260920'
 WHERE (SELECT COUNT(*) FROM `user` WHERE username = @secretary AND role = 'secretary') = 1
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'secretary_role_20260920');

-- ── 回滚（如需）：把同一个账号降回普通访客 ────────────────────────────────
-- UPDATE `user` SET role = 'user' WHERE username = @secretary;
-- DELETE FROM migration_flags WHERE flag_name = 'secretary_role_20260920';
