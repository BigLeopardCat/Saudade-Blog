USE saudade_blog;
-- =============================================================================
-- 账号冻结 + 令牌收回（20260926）：user.status / user.token_version
--
-- 为什么要有这两列（用户原话：「更改密码不能及时让已登录的设备及时下线就是其缺陷
-- 造成的」）：
--   本系统的登录令牌是**无状态 JWT**（HS256 自包含签名，服务端没有会话表）。
--   无状态的代价就是**没有收回手段**——令牌一旦签发，在 exp 到期之前，
--   改密码、封号、设备丢失，服务端一件事都做不了。这不是"配置没打开"，
--   是自包含令牌的结构性缺口（详见 docs/security-boundary.md「令牌收回」一节）。
--   补齐它需要**服务端状态**，本文件就是那份状态：
--     · `status`        = 账号能不能用（冻结账号功能）；
--     · `token_version` = 令牌代次。签发时把当前值写进 JWT 的 `ver` 声明，
--       之后每个请求拿库里的值与它比——**只要把库里的值 +1，此前签发的全部
--       令牌当场作废**（改密码 / 管理员重置 / 紧急收回都走这一条）。
--   判据收敛在 `src/authz.rs::check_token` 一处，Rust 侧不散落第二份。
--
-- 两列的语义与取值（DB 列无 ENUM/CHECK 约束，`src/authz.rs` 是唯一声明处）：
--   status: 0 = 正常（唯一放行值）/ 1 = 冻结。
--     其余任何值按**冻结**处理（`is_frozen` 是 `status != 0`）——失败取向与
--     角色判定一致：不认识的状态一律当作"不能用"，不默认放行。
--   token_version: 只增不减的整数代次。**解冻不会把它减回去**（见下）。
--
-- 冻结与解冻的行为（写在这里，免得下次靠读代码猜）：
--   · 冻结 ⇒ 立刻拒登录、立刻拒改密码/用恢复码，并且**已有的令牌当场全部失效**
--     （`auth_uid` 每个请求查一次库，见 `src/auth_jwt.rs`）；
--   · 冻结的同时 `token_version` 也会 +1 ⇒ **解冻不会把冻结前的登录态还回来**，
--     解冻后必须重新登录。冻结是"全部踢下线"，不是"暂停一下"。
--
-- 幂等与执行前提：
--   · 两句 ALTER 都没有 IF NOT EXISTS（MySQL 的 ADD COLUMN 不支持它），
--     重复执行会报 `Duplicate column name` —— **那说明已经应用过了，停手即可**，
--     不会改坏任何数据（本文件不含 UPDATE/DELETE）。
--   · 不锁表：`user` 表是个位数行，ADD COLUMN 是即时元数据变更，
--     且 NOT NULL + DEFAULT 0 有默认值，存量行原地补齐，不需要重建。
--   · **零数据回填**：存量账号拿到 status=0（正常）、token_version=0，
--     而此刻所有在用的令牌 `ver` 声明缺省也是 0（`Claims.ver` 标了
--     `#[serde(default)]`，见 `src/auth_jwt.rs`）⇒ **上线不会把任何人踢下线**。
--     这是刻意的：改一次部署不该顺手注销全部会话。
--   · **迁移没跑不许推送**：Rust 一上线就按新列查 user 表（每个已登录请求都查），
--     列不存在 ⇒ 查询报错 ⇒ 全部鉴权失败。顺序只能是"先跑迁移、再 push"。
-- flag: user_status_token_version_20260926（migration_flags，勿重跑）
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- =============================================================================

-- 1) 账号状态：0=正常 / 1=冻结
ALTER TABLE `user`
    ADD COLUMN `status` tinyint(1) NOT NULL DEFAULT 0
        COMMENT '0=正常 / 1=冻结（其余值按冻结处理）；冻结即拒登录并作废已签发令牌'
        AFTER `role`;

-- 2) 令牌代次：签发时写进 JWT 的 ver 声明，库里值变大即作废此前全部令牌
ALTER TABLE `user`
    ADD COLUMN `token_version` int NOT NULL DEFAULT 0
        COMMENT '令牌代次（只增不减）；改密码/管理员重置/冻结时 +1，作废此前签发的全部令牌'
        AFTER `status`;

-- ── ① 自检：两列都在，类型与默认值对得上 ────────────────────────────────────
-- 期望：恰好 2 行，is_nullable 都是 NO，column_default 都是 0，
--       且 `status` 排在 `role` 之后、`token_version` 紧挨 `status`。
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND COLUMN_NAME IN ('status', 'token_version')
 ORDER BY ORDINAL_POSITION;

-- ── ② 存量行核对：不得出现非默认值（本文件不回填任何数据）────────────────────
-- 期望：`不是默认值的行数` = 0。**若不为 0，先停手查清是谁写的**——
-- 本文件之外没有任何代码能写出非 0 的值（那两个值只有冻结/改密码两条路会产生，
-- 而那两条路在本次部署后才存在）。
SELECT '存量行（预期 0）' AS done,
       COUNT(*)                                            AS 账号总数,
       SUM(status <> 0)                                    AS status_不是默认值的行数,
       SUM(token_version <> 0)                             AS token_version_不是默认值的行数
  FROM `user`;

-- ── ③ 冻结账号数量（跑完本文件后随时可查这一条看现状）───────────────────────
-- 冻结是**逐个账号**的操作，本条只是给一个当前快照；个位数用户的站，一行一眼看得完。
SELECT '当前冻结账号' AS done, id, username, role
  FROM `user`
 WHERE status <> 0
 ORDER BY id;

INSERT INTO migration_flags (flag_name) VALUES ('user_status_token_version_20260926');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'user_status_token_version_20260926';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- 两列一起撤（顺序：先撤后者；撤列会丢掉"谁被冻结过"这条事实，撤回前先记下来）：
--   ALTER TABLE `user` DROP COLUMN `token_version`;
--   ALTER TABLE `user` DROP COLUMN `status`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_status_token_version_20260926';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码一律按这两列查 user 表，
--    列没了就是全部鉴权失败（与"没跑迁移就推送"同一种破坏）。
