USE saudade_blog;
-- 20261011 撤掉「秘书」这一档角色（降级迁移；20260920 那条提升迁移的反面）。
-- 背景：agent 侧的身份/权限模型（Principal + scope 声明表 + 唯一判据）落地时顺带立了
-- `secretary` 这一档（Rust 侧 `src/authz.rs::ROLE_SECRETARY`）。此后它**从未被实际使用**：
-- 库里那一行 0 会话、0 消息、0 评论；能力层与 `user` **逐项相同**——两侧的可见工具都是
-- 31 个、双向差集为空。原因是它那两项"独占" scope（`read.any` / `write.content`）各挂着
-- **0 个**工具，也没有任何非工具消费方；全仓唯一一处秘书专属文案（Rust `chat.rs` 的
-- `"以秘书身份 · "` 审计前缀）结构上不可达（该角色进不了后台，而审计前缀是后台视图）。
-- 20261011 裁决：这一档直接撤掉——Rust 的取值域、agent 的授予表、前端徽章与建号文档
-- 已同步删掉。
--
-- 代码侧删掉之后，库里残留的 `role='secretary'` 行会变成**未登记角色**：
--   · Rust：`authz::is_known_role` 判假 ⇒ 它从后台账号列表里消失、也不能再被指派
--     （`check_role_change` 由 `UnknownRole` 接住）；
--   · agent：`scopes_for()` 是 `_ROLE_SCOPES.get(role, frozenset())` ⇒ **零权限**
--     （不会崩，但那个账号在对话里什么都做不了，连普通访客本来就有的读能力都没有）。
-- 所以本迁移**必须在代码上线之前**跑（仓里的规矩：迁移没跑不许 push）。反过来说，
-- 在库里还有 secretary 行时先上线代码，那一行会短暂变成"零能力幽灵号"。
--
-- 按**角色批量**、不点名任何账号（本仓是公开仓，账号名 / uid 不落仓库）。影响面就是
-- 库里所有 `role='secretary'` 的行，数量与身份先在 ① 里看清（生产上预期 ≤ 1 行）。

-- ── ① 核对：现在有几行是 secretary、分别是谁（预期 0 或 1 行）─────────────
SELECT id, username, role FROM `user` WHERE role = 'secretary';

-- ── ② 降级：批量改回普通访客；幂等（再跑一次影响 0 行）────────────────────
-- 为什么落到 `user` 而不是别的档：撤掉一档身份是**收回那一档身份**，既不是惩罚也不是
-- 提权。而 `secretary` 今天的实际能力与 `user` 逐项相同（见上），所以落回 user 之后
-- 那个账号的**可见行为零变化**——这正是「撤的是身份、不是能力」这条判据的形状，
-- 也是这个迁移唯一该有的落点。
UPDATE `user` SET role = 'user' WHERE role = 'secretary';

-- ── ③ 验收：**必须为 0**。不为 0 ⇒ ② 没跑干净（或又被写了新值），别继续执行 ④ ──
SELECT COUNT(*) AS must_be_0 FROM `user` WHERE role = 'secretary';

-- ── ④ 打标记：仅在 ③ 通过（库里已无 secretary）时写入；已存在则不重复写，可安全重跑 ──
INSERT INTO migration_flags (flag_name)
SELECT 'drop_secretary_role_20261011'
 WHERE (SELECT COUNT(*) FROM `user` WHERE role = 'secretary') = 0
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'drop_secretary_role_20261011');

-- ── 回滚（如需）：把那一行改回 secretary ──────────────────────────────────
-- ⚠️ **先回滚代码再回滚数据**：`KNOWN_ROLES` 里把 secretary 加回去（两仓各一处），
--    否则改回去的那一刻那个账号就是"未登记角色"（后台看不见、agent 零权限）。
-- UPDATE `user` SET role = 'secretary' WHERE username = '<当时那个账号>';
-- DELETE FROM migration_flags WHERE flag_name = 'drop_secretary_role_20261011';
