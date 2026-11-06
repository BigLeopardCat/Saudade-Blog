USE saudade_blog;
SELECT 'state' AS done,
       (SELECT COUNT(*) FROM user WHERE username = 'agent_fixture_freeze_a') AS rows_now,
       (SELECT COUNT(*) FROM user) AS total_users;

SELECT 'prefix_family' AS done, id, username, role, status FROM user
 WHERE username LIKE 'agent\_fixture\_%';

-- 停机闸：**同名账号恰好一个**才允许往下（0 = 待插，1 = 待复位）。
-- 多于 1 行说明有人手工插过重复的名字——那种库里状态不该被本文件顺手改掉，先查清。
SELECT 'must_be_0_or_1' AS done,
       (SELECT COUNT(*) FROM user WHERE username = 'agent_fixture_freeze_a') AS n,
       CASE WHEN (SELECT COUNT(*) FROM user
                   WHERE username = 'agent_fixture_freeze_a') > 1
            THEN 'STOP' ELSE 'OK' END AS gate;

-- ── ② 幂等：不在就插（插出来就是冻结态）；在就**复位成冻结态** ─────────────
-- 两段都只认**整名相等**这一个判据，不写 id（让 AUTO_INCREMENT 自己分配，同
-- `golden_write_fixture_20260925.sql` 的理由：显式写高 id 会把它永久抬上去）。
-- 复位那句是本文件与分类族那半**刻意的不对称**：分类夹具被用例删掉后由 §② 重新插入，
-- 账号夹具被用例解冻后由这句更新回去——因为用例改的是它的**状态**而不是存在性。
-- 它只可能命中本文件建的那一行（精确名字 + 前缀族），碰不到任何真账号。
INSERT INTO user (username, nickname, password, role, status, token_version)
SELECT 'agent_fixture_freeze_a',
       '评测夹具（golden 真写用例的靶子，冻结态；见 golden_fixture_account_20260926.sql）',
       'agent_fixture_no_login_do_not_use',
       'user', 1, 0
 WHERE NOT EXISTS (SELECT 1 FROM user WHERE username = 'agent_fixture_freeze_a');
UPDATE user SET status = 1 WHERE username = 'agent_fixture_freeze_a';
-- `token_version` **刻意不复位**：它是"令牌代次"，只增不减（解冻不会把它减回去，
-- 见 `auth_jwt`）。夹具从不登录 ⇒ 它外面没有任何已签发的令牌，复位它没有任何意义，
-- 反而会让"谁在什么时候动过它"这条痕迹变模糊。

-- ── ③ 回读：确认**恰好一行**、字段如预期 ───────────────────────────────────
-- 期望：1 行，status=1（冻结），role=user，id 是自增分配的（不写死）。
SELECT 'fixture' AS done, id, username, role, status, token_version,
       (SELECT COUNT(*) FROM user WHERE username = 'agent_fixture_freeze_a') AS must_be_1
  FROM user WHERE username = 'agent_fixture_freeze_a';

-- ── ④ 写后复核：这一行**真的能被后台账号名录看到** ─────────────────────────
-- 用例第 1 轮的名通道要按名字把它解析出来（`tools/base.py::_user_directory` ←
-- `GET /api/temp-users`，与下面的接口同一个 handler：`src/routes/temp_user.rs`），
-- 所以"在位"的定义就是**这个接口读得到它**，判据还包括 status 必须是 1。
-- （SQL 里读不到 HTTP，这一条用 curl 验，带一个管理员令牌：
--   `curl -s -H "Authorization: Bearer <admin token>" https://saudade.site/api/temp-users`
--   找 `agent_fixture_freeze_a`；eval 侧有机械检查：`python eval/golden_fixture_account.py --verify`。）

-- ── ⑤ 登记 flag（**不参与幂等**，只记"本文件被应用过至少一次"）──────────────
-- 同 `golden_write_fixture_20260925.sql`：真正的门是 §② 的 `NOT EXISTS` 与用例侧的
-- 夹具在位检查，flag 不参与判断（否则"用例解冻之后想复位"这条正常循环会静默不动）。
INSERT INTO migration_flags (flag_name)
SELECT 'golden_fixture_account_20260926'
 WHERE NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'golden_fixture_account_20260926');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_fixture_account_20260926';

-- ── 回滚（如需）：只删前缀族，**一个真账号都碰不到** ───────────────────────
-- ⚠️ 级联清理**不是外键**做的，是 `temp_user.rs::delete_temp_user` 里的三条 delete_many
-- （chat_history / chat_summary / conversation）——所以裸 SQL 删 user 行**不会**带走
-- 会话数据。两条路选一条：
--   ① 走接口（会级联，且夹具的 role 正是 `user`，这个入口认得它）：
--      `DELETE /api/temp-users/<夹具 id>`（带管理员令牌）；
--   ② 纯 SQL：先删那三张表里 `UserId = <夹具 id>` 的行，再
--      `DELETE FROM user WHERE username LIKE 'agent\_fixture\_%';`
-- **夹具从不登录、不发起对话**，所以按设计那三张表里名下一行都没有（②的第一句删 0 行）
-- ——除非有人在夹具在位期间拿它登录过。删之前查一眼再动手：
--   `SELECT (SELECT COUNT(*) FROM chat_history WHERE UserId = <id>) AS hist,
--           (SELECT COUNT(*) FROM conversation WHERE UserId = <id>) AS convs;`
-- 最后：`DELETE FROM migration_flags WHERE flag_name = 'golden_fixture_account_20260926';`
--
-- ── 已知副作用（先知道再落地）──────────────────────────────────────────────
--   · 夹具会**留在后台账号列表里**（role=user、状态"已冻结"那一行）——它本来就是
--     给"按名字冻结/解冻"用的，看得见是设计的一部分（分类族那条同理）。
--   · 它也会在后台数据板的**逐人活动表**里占一行（`stats.rs::user_stats` 是普查，
--     不过滤零活动账号），数值恒为 0。
--   · 它**不**出现在公开面任何地方（账号名录是管理员域接口）。
--   · 本文件必须在**代码上线之后**跑：`is_known_role` / `is_listable_role` 与冻结策略
--     都要新代码才认识这些取值（与 `superadmin_role_20260926.sql`、与常规的"迁移没跑
--     不许 push"**顺序相反**——这条是数据夹具，不是结构迁移，先有代码才有它的位置）。
