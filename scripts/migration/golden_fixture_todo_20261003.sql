USE saudade_blog;
-- =============================================================================
-- 20261003 golden 弹卡用例夹具：待办 `agent_fixture_todo_pending_a（评测夹具，勿手改）`
--        （主人 = 721 `agent_test_admin_721`）
--
-- 这是 golden 用例 `admin_todo_done_popup` 要动的那一行。它证明的是**真身份那一跳**：
-- 「把待办「X」勾成完成」这一轮，agent 拿着真管理员令牌去后台首页那份待办列表里
-- **真的找到了那一行**、于是卡面印出了它的排期与现状（`agent/adminops.py::
-- render_todo_done_action` 的那三种状态里最完整的一种）。
--
-- ## 为什么以前不需要它，现在需要（这条夹具是「开真身份通道」的落地物）
--
-- 那条用例此前跑在 uid=0。待办列表是**管理员域**接口（`src/middleware.rs::auth_guard`），
-- 所以 uid=0 时 `agent/graph.py::_write_target_refusal` 的 `is_todo` 支与 `_confirm_popup`
-- 的 todos 快照都读不到东西 —— 预检 **fail-open**（按设计：拿不到实据也照弹卡），
-- 卡面按设计只印正文。两个后果都不是 bug，但都让用例的证明力少一截：
--   · 「目标真的在台账里、且唯一」这一跳**从未被端到端验过**；
--   · 卡面那三种状态（「没有这一条」/「有 N 条都叫这个」/「排期 …，现在：未完成」）
--     一条都到不了——而这三行正是主人点确定**之前**唯一能核对的东西。
--
-- 现在用例带 `needs_admin_uid` + `requires_fixture_kind: "todo"`，夹具闸会拿真管理员
-- 令牌读这份列表来判它在不在位（`eval/golden_fixture_todo.py`），用例正文也**逐字断言
-- 卡面印出了这条排期与现状**（见下面「与用例侧的约定」）。
--
-- ## 为什么建在 721 名下，而不是主人自己那个管理员账号
--
-- 待办列表是**按 uid 过滤**的（`src/routes/todos.rs` 每个 handler 都做），而这条用例读的
-- 正是**发起人自己**那份列表——所以夹具必须挂在 golden 用的那个管理员 uid 名下。
--   · golden 的管理员身份就是 `GOLDEN_ADMIN_UID`（`scripts/nightly_regression.sh` 里写的是
--     721 = `agent_test_admin_721`，20260924 建的评测专用账号，密码是三个 UUID 拼起来的、
--     **没有任何人知道**，见 `test_accounts_20260924.sql`）。
--   · 这一点是刻意的好处：那份列表**永远不会有第二个写者**。前端那张待办卡保存走的是
--     `PUT /api/protected/todos` —— **整份列表覆盖**（`todos.rs::save_todos`：事务内先删该
--     用户全部行再逐条插入，取舍见 `dashboard_todo_20260924.sql` 头注）。也就是说：谁要是
--     在后台首页点一下保存，**库里那行会连同前端不知道的其它行一起被删掉**。夹具落在
--     721 名下就没有这个问题——它从不登录、也不会有前端拿它去 PUT。
--     （代价如实记：这条夹具**看不见即消失**，没有人会注意到它被删了；防守是那道闸——
--     不在位 ⇒ 用例 `[skip]`，跳过理由里点着本文件的名字。）
--
-- ## 族约定：夹具建出来就是「未完成」，而且**恰好一条**
--
-- 两个期望值都不是口味问题，各自对着一条判据（逐条见 `eval/golden_fixture_todo.py` 头注）：
--   · **未完成**（`done = 0`）—— 勾完成的动作前面有一道判据
--     `reached_specs`（`agent/adminops.py`）：「这一行已经是完成态 ⇒ 本轮零改动收尾、
--     **不弹卡**」。夹具要是已完成，用例要的那张卡根本不存在 ⇒ 红，且红的样子与
--     「模型退化」一模一样。
--   · **恰好一条** —— 待办族的定位判据是**正文逐字相等且唯一**
--     （`tools/base.py::_todo_text_hits` 与 `src/routes/todos.rs::pick_todo` 是同一句话：
--     歧义即零写）。同名两条时预检与工具两侧都会拒，卡同样弹不出来。
--
-- ## 与用例侧的约定（改这里要同步改那边）
--
--   · 主人 uid 恒 721；正文逐字：`agent_fixture_todo_pending_a（评测夹具，勿手改）`
--     （`eval/golden/basic.jsonl` 的 `admin_todo_done_popup`：`requires_fixture` +
--      `requires_fixture_kind: "todo"` + `needs_admin_uid`）
--   · 状态恒 `done = 0`（未完成）；**排期恒 `2026-11-30`**（渲染成「11月30日」）：
--     用例的 `text_any_regex` 断言卡面出现
--     `把待办「…」勾成完成（排期 11月30日，现在：未完成）`——那个日子是**台账真值**，
--     模型编不出来、uuid=0 那份退化卡面也没有它。**改本文件的排期就要同步改用例**，
--     否则金集会红成「模型没按台账念」，而不是红成「这条断言的前提过期了」。
--   · 正文带保留前缀 `agent_fixture_`：清场、排查一律可以写成
--     `... WHERE text LIKE 'agent\_fixture\_%'` ⇒ 结构上不可能误删真待办
--   · 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑
--
-- ── ① 现状核对（先看，再决定要不要插）──────────────────────────────────────
-- 期望 `rows_now` 为 0（第一次跑）或 1（上一次跑过）。`list_total` 只是把 721 那份
-- 列表此刻的样子留在执行记录里（正常应当就是本文件这一行）。`prefix_family` 应当是
-- **空**或只有本文件这一行：有别的东西时先查清楚再往下走（那是残留，不是夹具）。
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

-- ── ② 幂等：不在就插（插出来就是未完成 + 有排期）；在就**复位成未完成 + 排期** ────
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

-- ── ③ 回读：确认**恰好一行**、字段如预期 ───────────────────────────────────
-- 期望：1 行，done = 0，due_date = 2026-11-30，sort_order = 0，id 是自增分配的（不写死）。
SELECT 'fixture' AS done, id, user_id, sort_order, `text`, `done`, due_date, updated_at,
       (SELECT COUNT(*) FROM dashboard_todo
         WHERE user_id = 721 AND `text` = 'agent_fixture_todo_pending_a（评测夹具，勿手改）') AS must_be_1
  FROM dashboard_todo
 WHERE user_id = 721 AND `text` = 'agent_fixture_todo_pending_a（评测夹具，勿手改）';

-- ── ④ 写后复核：这一行**真的能被后台待办接口看到** ───────────────────────────
-- 用例第 1 轮的目标解析走的是**同一份列表**（`agent/graph.py::_todo_rows` ←
-- `GET /api/protected/todos`，与下面那条接口同一个 handler：`src/routes/todos.rs`），
-- 所以"在位"的定义就是**这个接口对 uid=721 读得到它、且 done=0**（判据还包括"恰好一条"）。
-- （SQL 里读不到 HTTP，这一条用 curl 验，带 721 的管理员令牌：
--   `curl -s -H "Authorization: Bearer <721 的 admin token>" https://saudade.site/api/protected/todos`
--   找 `agent_fixture_todo_pending_a（评测夹具，勿手改）`；eval 侧有机械检查：
--   `GOLDEN_ADMIN_UID=721 .venv/bin/python eval/golden_fixture_todo.py --verify`。）

-- ── ⑤ 登记 flag（**不参与幂等**，只记"本文件被应用过至少一次"）──────────────
-- 同 `golden_write_fixture_20260925.sql` / `golden_fixture_account_20260926.sql`：真正的门是
-- §② 的 `NOT EXISTS` 与用例侧的夹具在位检查，flag 不参与判断（否则"用例把它勾成完成之后
-- 想复位"这条正常循环会静默不动）。
INSERT INTO migration_flags (flag_name)
SELECT 'golden_fixture_todo_20261003'
 WHERE NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'golden_fixture_todo_20261003');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_fixture_todo_20261003';

-- ── 回滚（如需）：只删前缀族（限定 user_id = 721），**一条真待办都碰不到** ──────
-- 本表**没有外键**（`dashboard_todo_20260924.sql` 头注写明：`user_id` 只是过滤条件，
-- 销号不会带走这里的行）⇒ 删这一行不会顺带动 `user` 表或任何会话数据，一条 DELETE 就够。
--   DELETE FROM dashboard_todo
--    WHERE user_id = 721 AND text LIKE 'agent\_fixture\_%';
--   DELETE FROM migration_flags WHERE flag_name = 'golden_fixture_todo_20261003';
-- 721 账号本身**不要**顺手删（它带着 golden 的另一批身份用例，见
-- `test_accounts_20260924.sql` 的回滚段）。
--
-- ── 已知副作用（先知道再落地）──────────────────────────────────────────────
--   · 夹具会**出现在 721 的后台首页待办卡上**（一条名为「agent_fixture_todo_pending_a
--     （评测夹具，勿手改）」、排期 11月30日、未勾的行）。无人登录 721 ⇒ 无人看得见；
--     但这正是"它一旦被谁清了就没人知道"的另一面（防守 = 夹具闸，不在位 ⇒ `[skip]`）。
--   · 它**不**出现在公开面任何地方（待办列表是管理员域接口，连普通登录用户也读不到）。
--   · 它**不**参与后台数据板的任何统计（那张表按 `user` 普查活动，本表只是一份私有清单）。
--   · 本文件必须在**代码上线之后**跑：用具例侧那三处（`requires_fixture_kind: "todo"` 的
--     分派、`needs_admin_uid` 的身份注入）都要新代码才认得（与常规的"迁移没跑不许 push"
--     **顺序相反**——这条是数据夹具，不是结构迁移，先有代码才有它的位置）。
