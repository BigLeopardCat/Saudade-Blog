USE saudade_blog;
SELECT id, username, role FROM `user` WHERE role = 'secretary';

-- ② 降级：批量改回普通访客；幂等（再跑一次影响 0 行）
-- 为什么落到 `user` 而不是别的档：撤掉一档身份是**收回那一档身份**，既不是惩罚也不是
-- 提权。而 `secretary` 今天的实际能力与 `user` 逐项相同（见上），所以落回 user 之后
-- 那个账号的**可见行为零变化**——这正是「撤的是身份、不是能力」这条判据的形状，
-- 也是这个迁移唯一该有的落点。
UPDATE `user` SET role = 'user' WHERE role = 'secretary';

-- ③ 验收：**必须为 0**。不为 0 ⇒ ② 没跑干净（或又被写了新值），别继续执行 ④
SELECT COUNT(*) AS must_be_0 FROM `user` WHERE role = 'secretary';

-- ④ 打标记：仅在 ③ 通过（库里已无 secretary）时写入；已存在则不重复写，可安全重跑
INSERT INTO migration_flags (flag_name)
SELECT 'drop_secretary_role_20261011'
 WHERE (SELECT COUNT(*) FROM `user` WHERE role = 'secretary') = 0
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'drop_secretary_role_20261011');
