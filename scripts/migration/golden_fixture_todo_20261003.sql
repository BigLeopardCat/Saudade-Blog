USE saudade_blog;
SELECT 'state' AS done,
       (SELECT COUNT(*) FROM dashboard_todo
         WHERE user_id = 721 AND `text` = 'agent_fixture_todo_pending_a（评测夹具，勿手改）') AS rows_now,
       (SELECT COUNT(*) FROM dashboard_todo WHERE user_id = 721) AS list_total;

SELECT 'prefix_family' AS done, id, user_id, sort_order, `text`, `done`, due_date
  FROM dashboard_todo
 WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%';

-- 停机闸：**前缀族恰好 0 到 1 行**才允许往下（0 = 待插，1 = 待复位）。
-- 多于 1 行说明有东西脱离了契约（中断的重复插入 / 手工改过正文）——那种库里状态不该被
-- 本文件顺手改掉，先查清"到底哪一行才是那条夹具"。**本文件的复位段不消除歧义**
-- （它按前缀命中、会把每一行都置成未完成，于是两条同名都变"未完成"⇒ 闸仍判 wrong_state）。
SELECT 'must_be_0_or_1' AS done,
       (SELECT COUNT(*) FROM dashboard_todo
         WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%') AS n,
       CASE WHEN (SELECT COUNT(*) FROM dashboard_todo
                   WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%') > 1
            THEN 'STOP' ELSE 'OK' END AS gate;

-- ② 幂等：不在就插（插出来就是未完成 + 有排期）；在就**复位成未完成 + 排期**
-- 两段都只认**前缀 + 主人**这一个判据，不写 id（让 AUTO_INCREMENT 自己分配，同
-- `golden_write_fixture_20260925.sql` 的理由：显式写高 id 会把它永久抬上去）。
-- 复位那句是本文件与分类族那半**刻意的不对称**，与账号族那半同一条道理：分类夹具被用例
-- 删掉后由 §② 重新插入，这条夹具被用例勾成完成之后由 UPDATE 勾回去——因为用例改的是它
-- 的**状态**（`done`）而不只是存在性，而且**它本身不会被用例删掉**（这条用例只弹卡、
-- 零执行；就算真走到执行，`set_todo_done` 也只翻 `done`，不删行）。
-- `sort_order = 0`：721 那份列表是空的（`list_total` 应当与夹具行数相等），位次随它。
-- 只可能命中本文件建的那一行（精确前缀 + 精确 uid），碰不到任何真待办。
INSERT INTO dashboard_todo (user_id, sort_order, `text`, `done`, due_date)
SELECT 721, 0, 'agent_fixture_todo_pending_a（评测夹具，勿手改）', 0, DATE '2026-11-30'
 WHERE NOT EXISTS (SELECT 1 FROM dashboard_todo
                    WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%');
UPDATE dashboard_todo SET `done` = 0, due_date = DATE '2026-11-30'
 WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%';
-- `created_at` / `updated_at` **不碰**（`updated_at` 由 ON UPDATE CURRENT_TIMESTAMP 自己走，
-- 那是"这一行最近被动过"的痕迹，抹平它只会让"谁什么时候复位过"变模糊）。

-- ③ 回读：确认**恰好一行**、字段如预期
-- 期望：1 行，done = 0，due_date = 2026-11-30，sort_order = 0，id 是自增分配的（不写死）。
SELECT 'fixture' AS done, id, user_id, sort_order, `text`, `done`, due_date, updated_at,
       (SELECT COUNT(*) FROM dashboard_todo
         WHERE user_id = 721 AND `text` = 'agent_fixture_todo_pending_a（评测夹具，勿手改）') AS must_be_1
  FROM dashboard_todo
 WHERE user_id = 721 AND `text` = 'agent_fixture_todo_pending_a（评测夹具，勿手改）';

-- ④ 写后复核：这一行**真的能被后台待办接口看到**
-- 用例第 1 轮的目标解析走的是**同一份列表**（`agent/graph.py::_todo_rows` ←
-- `GET /api/protected/todos`，与下面那条接口同一个 handler：`src/routes/todos.rs`），
-- 所以"在位"的定义就是**这个接口对 uid=721 读得到它、且 done=0**（判据还包括"恰好一条"）。
-- （SQL 里读不到 HTTP，这一条用 curl 验，带 721 的管理员令牌：
--   `curl -s -H "Authorization: Bearer <721 的 admin token>" https://saudade.site/api/protected/todos`
--   找 `agent_fixture_todo_pending_a（评测夹具，勿手改）`；eval 侧有机械检查：
--   `GOLDEN_ADMIN_UID=721 .venv/bin/python eval/golden_fixture_todo.py --verify`。）

-- ⑤ 登记 flag（**不参与幂等**，只记"本文件被应用过至少一次"）
-- 同 `golden_write_fixture_20260925.sql` / `golden_fixture_account_20260926.sql`：真正的门是
-- §② 的 `NOT EXISTS` 与用例侧的夹具在位检查，flag 不参与判断（否则"用例把它勾成完成之后
-- 想复位"这条正常循环会静默不动）。
INSERT INTO migration_flags (flag_name)
SELECT 'golden_fixture_todo_20261003'
 WHERE NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'golden_fixture_todo_20261003');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_fixture_todo_20261003';

-- 回滚（如需）：只删前缀族（限定 user_id = 721），**一条真待办都碰不到**
-- 本表**没有外键**（`dashboard_todo_20260924.sql` 头注写明：`user_id` 只是过滤条件，
-- 销号不会带走这里的行）⇒ 删这一行不会顺带动 `user` 表或任何会话数据，一条 DELETE 就够。
--   DELETE FROM dashboard_todo
--    WHERE user_id = 721 AND text LIKE 'agent\_fixture\_%';
--   DELETE FROM migration_flags WHERE flag_name = 'golden_fixture_todo_20261003';
-- 721 账号本身**不要**顺手删（它带着 golden 的另一批身份用例，见
-- `test_accounts_20260924.sql` 的回滚段）。
--
-- 已知副作用（先知道再落地）
--   · 夹具会**出现在 721 的后台首页待办卡上**（一条名为「agent_fixture_todo_pending_a
--     （评测夹具，勿手改）」、排期 11月30日、未勾的行）。无人登录 721 ⇒ 无人看得见；
--     但这正是"它一旦被谁清了就没人知道"的另一面（防守 = 夹具闸，不在位 ⇒ `[skip]`）。
--   · 它**不**出现在公开面任何地方（待办列表是管理员域接口，连普通登录用户也读不到）。
--   · 它**不**参与后台数据板的任何统计（那张表按 `user` 普查活动，本表只是一份私有清单）。
--   · 本文件必须在**代码上线之后**跑：用具例侧那三处（`requires_fixture_kind: "todo"` 的
--     分派、`needs_admin_uid` 的身份注入）都要新代码才认得（与常规的"迁移没跑不许 push"
--     **顺序相反**——这条是数据夹具，不是结构迁移，先有代码才有它的位置）。
