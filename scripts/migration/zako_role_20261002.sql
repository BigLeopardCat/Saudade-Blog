USE saudade_blog;
-- 20261002 杂鱼角色落库（"杂鱼"零工具身份的前置步骤）。
-- 背景：agent 侧的身份/权限模型（Principal + scope 声明表 + 唯一判据）已落地，Rust 侧
-- `src/authz.rs::KNOWN_ROLES` 与 agent 侧 `agent/principal.py::KNOWN_ROLES` 都加了
-- `zako`。库里今天没有一行是 zako，所以"和杂鱼对话"这条路径一次也没被真实数据走过。
-- 本迁移把**一个**账号提升为 zako（体验账号：整轮零工具，只用雌小鬼口吻闲聊）。
--
-- 只改一行，不做批量、不建角色表、不动任何现有账号的角色：
--   admin    = 博主本人（后台全权，auth_guard 唯一准入角色族）
--   user     = 访客/体验号（本迁移不动）
--   secretary= 秘书（本迁移不动）
--   zako     = 提升后的这一个账号（零工具：agent 侧 planner 顶层短路，
--              execute 节点在本请求里一次都不会被进入——见
--              saudade-blog-agent/docs/secretary.md §3.6）
--
-- ⚠️ **必须最后跑**：先让新代码上线（agent 仓 push + restart、父仓 Rust/前端 deploy），
--    再执行本迁移。旧二进制/旧 agent 不认识 `zako` ⇒ `is_known_role` 判假、
--    `can_access_console` 判假、`set_user_status` 会回"该账号角色未登记，不能改状态"，
--    agent 侧 `known_role` 回 None（拿到的是访客口径 + 零权限）——那个账号会变得
--    在后台不可管理。反方向（先部署、后改库）在库里没有 zako 行时逐字节无变化。
--
-- 执行顺序（**先建号、再提权**）：
--   ① 后台「临时用户」面板用 `POST /api/temp-users` 建一个普通账号（该接口用
--      Argon2id 落密码，属正规路径；本迁移不插密码哈希，也就不需要把口令写进 SQL）；
--   ② 把这个账号的用户名填进下面的 @zako；
--   ③ 逐段执行（① 看、② 改、③ 验收、④ 打标记）。
--
-- ⚠️ 与秘书那条的一条**不同**（别看错）：zako 是"已知角色且非超管" ⇒ 它会出现在后台
--    「临时用户」账号列表里（判据是 `authz::is_listable_role`）。这是**设计**——博主得
--    看得见它、能冻它、能改它的身份（zako 在 `is_assignable_role` 的可指派范围内）。
--    secretary 迁移注释里那句"提权后不再出现在临时用户列表"描述的是更早的过滤实现。

-- ── 前置：目标账号名（须与库里实际用户名**完全一致**，大小写敏感）──────────
-- 不存在也不会报错（下一步影响 0 行、③ 的 must_be_1 会变成 0）——所以 ③ 必须看。
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
