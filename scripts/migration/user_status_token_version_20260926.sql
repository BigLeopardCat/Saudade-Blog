-- flag: user_status_token_version_20260926（migration_flags，勿重跑）
USE saudade_blog;
ALTER TABLE `user`
    ADD COLUMN `status` tinyint(1) NOT NULL DEFAULT 0
        COMMENT '0=正常 / 1=冻结（其余值按冻结处理）；冻结即拒登录并作废已签发令牌'
        AFTER `role`;

ALTER TABLE `user`
    ADD COLUMN `token_version` int NOT NULL DEFAULT 0
        COMMENT '令牌代次（只增不减）；改密码/管理员重置/冻结时 +1，作废此前签发的全部令牌'
        AFTER `status`;

-- ① 自检：两列都在，类型与默认值对得上
-- 期望：恰好 2 行，is_nullable 都是 NO，column_default 都是 0，
--       且 `status` 排在 `role` 之后、`token_version` 紧挨 `status`。
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND COLUMN_NAME IN ('status', 'token_version')
 ORDER BY ORDINAL_POSITION;

-- ② 存量行核对：不得出现非默认值（本文件不回填任何数据）
-- 期望：`不是默认值的行数` = 0。**若不为 0，先停手查清是谁写的**——
-- 本文件之外没有任何代码能写出非 0 的值（那两个值只有冻结/改密码两条路会产生，
-- 而那两条路在本次部署后才存在）。
SELECT '存量行（预期 0）' AS done,
       COUNT(*)                                            AS 账号总数,
       SUM(status <> 0)                                    AS status_不是默认值的行数,
       SUM(token_version <> 0)                             AS token_version_不是默认值的行数
  FROM `user`;

-- ③ 冻结账号数量（跑完本文件后随时可查这一条看现状）
-- 冻结是**逐个账号**的操作，本条只是给一个当前快照；个位数用户的站，一行一眼看得完。
SELECT '当前冻结账号' AS done, id, username, role
  FROM `user`
 WHERE status <> 0
 ORDER BY id;

INSERT INTO migration_flags (flag_name) VALUES ('user_status_token_version_20260926');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'user_status_token_version_20260926';

-- 回滚（如需）
-- 两列一起撤（顺序：先撤后者；撤列会丢掉"谁被冻结过"这条事实，撤回前先记下来）：
--   ALTER TABLE `user` DROP COLUMN `token_version`;
--   ALTER TABLE `user` DROP COLUMN `status`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_status_token_version_20260926';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码一律按这两列查 user 表，
--    列没了就是全部鉴权失败（与"没跑迁移就推送"同一种破坏）。
