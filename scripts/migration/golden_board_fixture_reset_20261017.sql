USE saudade_blog;
SELECT 'state' AS done,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%')          AS family_rows,
       (SELECT COUNT(*) FROM talk WHERE src = 'board' AND approved = 0)           AS other_pending,
       (SELECT COUNT(*) FROM talk WHERE src = 'board' AND approved = 2)           AS board_rejected;

SELECT 'before' AS done, id, approved, src, user_id, author,
       ai_result, ai_reason, reject_reason, created_at, updated_at, LEFT(content, 60) AS content
  FROM talk WHERE content LIKE 'agent\_fixture\_%';

SELECT 'must_be_exactly_1' AS done,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') AS n,
       CASE WHEN (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') = 1
            THEN 'OK' ELSE 'STOP' END AS gate;

UPDATE talk
   SET approved      = 0,
       ai_result     = NULL,
       ai_reason     = NULL,
       reject_reason = NULL
 WHERE content LIKE 'agent\_fixture\_%'
   AND approved <> 0;

-- ③ 回读：确认**恰好一行**、字段如预期
-- 期望：1 行，approved = 0，三个审核列都是 NULL，must_be_1 = 1。
SELECT 'fixture' AS done, id, approved, src, user_id, author,
       ai_result, ai_reason, reject_reason, created_at, updated_at,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') AS must_be_1
  FROM talk WHERE content LIKE 'agent\_fixture\_%';

-- ④ 写后复核：这一行**真的能被后台接口看到、且是待审态**
-- 用例的台账帧读的是 `GET /api/protect/board`（`tools/base._board_index`），所以"在位"
-- 的定义就是**那个接口读得到它、且 approved = 0**。SQL 里读不到 HTTP，这一条用一枚
-- **只读的管理员令牌**验：
--   `GOLDEN_ADMIN_UID=756 .venv/bin/python eval/golden_fixture_board.py --verify`
-- （跑在 agent 仓；夹具闸那一路是 `golden_fixture.gate(cases)`，逐族判 present/wrong_state。）
-- ⚠️ 库里改对了、闸仍判 wrong_state ⇒ 先查身份与路由（管理员 uid 今天还通不通），
--    不要改用例去迁就。

-- ⑤ 登记 flag（**不参与幂等**，只记"本文件被应用过至少一次"）
-- 同其余夹具文件：真正的门是 §② 的 `approved <> 0` 与用例侧的夹具在位检查，flag 不参与
-- 判断（否则"用例复核掉它之后想复位"这条正常循环会静默不动）。
INSERT INTO migration_flags (flag_name)
SELECT 'golden_board_fixture_reset_20261017'
 WHERE NOT EXISTS (SELECT 1 FROM migration_flags
                    WHERE flag_name = 'golden_board_fixture_reset_20261017');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_board_fixture_reset_20261017';
