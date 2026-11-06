USE saudade_blog;
SELECT 'state' AS done,
       (SELECT COUNT(*) FROM talk WHERE src = 'board' AND approved = 0) AS pending_now,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') AS fixture_rows,
       (SELECT COUNT(*) FROM user WHERE id = 721) AS admin721;

-- 前缀族的完整清单：**这份清单里的每一行都是夹具**，不含任何真留言。
-- 有意外的东西（正文像夹具却不是本文件建的）时，先查清楚再往下走。
SELECT 'prefix_family' AS done, id, approved, src, user_id, LEFT(content, 60) AS content
  FROM talk WHERE content LIKE 'agent\_fixture\_%';

-- ── ② 幂等插入（重复跑是空操作）────────────────────────────────────────────
-- 判据只有"这个前缀的行在不在"，**不看 flag**。不指定 id（让 AUTO_INCREMENT 自己分配：
-- 显式写一个高 id 会把它永久抬上去，同 `golden_write_fixture_20260925.sql` 里那条理由）。
-- `title` 与 `cat` 都写 '愿'——`routes/talks.rs::insert_talk` 对河灯就是 `title = cat`
-- 且 `cat ∈ {愿,寄,忆,诉}`，照它落库，免得后台某一列渲染成空。
-- `ai_result` / `ai_reason` / `reject_reason` 留 NULL = **没走过 AI 审核**（后台把它显示成
-- "未审"，那正是"人工全审"这个开关组合下的正常形态），**不编一个假的 pass/flag**。
-- `v = 0`（灯型：0 莲花 / 1 八角 / 2 圆笼）。
-- **没有任何 `ON DUPLICATE KEY` / `REPLACE`**（静默改掉一行已有数据比失败更坏）。
INSERT INTO talk (title, content, cat, v, author, user_id, src, approved,
                  ai_result, ai_reason, reject_reason, created_at, updated_at)
SELECT '愿', 'agent_fixture_待审留言（评测夹具，用后即删）', '愿', 0,
       'agent_fixture', 721, 'board', 0, NULL, NULL, NULL, NOW(), NOW()
 WHERE NOT EXISTS (SELECT 1 FROM talk WHERE content LIKE 'agent\_fixture\_%');

-- ── ③ 回读：确认**恰好一行**、且是待审态 ───────────────────────────────────
-- 期望：1 行，`approved` = 0，`must_be_1` = 1。行数与状态是后面每一步的前提。
SELECT 'fixture' AS done, id, approved, src, user_id, author, content,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') AS must_be_1
  FROM talk WHERE content LIKE 'agent\_fixture\_%';

-- ── ④ 写后复核：这一行**真的能被后台接口看到** ─────────────────────────────
-- 用例的台账帧读的是 `GET /api/protect/board`（`tools/base._board_index`），所以
-- "在位"的定义就是**那个接口读得到它、且 approved=0**。SQL 里读不到 HTTP，这一条要
-- 用一枚**只读的管理员令牌**验——那是**待补的一件**：`eval/golden_fixture_board.py`
-- （照 `golden_fixture_account.py` 那条只读路径写：自签一枚管理员令牌、只看不写），
-- 连同用例侧的 `requires_fixture_kind: "board"` 与夹具闸的第三族，**在本文件应用之后**
-- 才写（对着真行写、才验得了）。
-- ⚠️ 库里插进去了、接口读不到 ⇒ 用例仍会 SKIP：那种情况要先查为什么（身份/路由/缓存），
--    不要改用例去迁就。
--
-- ── ⑤ 登记 flag（**不参与幂等**，只记"本文件被应用过至少一次"）──────────────
INSERT INTO migration_flags (flag_name)
SELECT 'golden_board_fixture_20260930'
 WHERE NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'golden_board_fixture_20260930');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_board_fixture_20260930';

-- ── 回滚（如需）：只删前缀族，**一条真留言都碰不到** ───────────────────────
-- DELETE FROM talk WHERE content LIKE 'agent\_fixture\_%';
-- DELETE FROM migration_flags WHERE flag_name = 'golden_board_fixture_20260930';
--
-- ── 已知副作用（先知道再落地）──────────────────────────────────────────────
--   · 夹具在位期间，「评论管理」列表里多一条待审行、`get_moderation_status` 的待审计数
--     比真实值多 1（**公开页面上看不到**——approved=0 不进公开列表）。
--   · 用例只弹卡不点确定 ⇒ 它**一直是待审的**（这是设计，不是残留）。
--   · 清场就是上面那条前缀 DELETE + 重跑本文件。
