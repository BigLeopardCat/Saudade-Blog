DO $$
DECLARE n int;
BEGIN
  DELETE FROM "quota_request" q
   WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = q.user_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '① quota_request：删了 % 行孤儿申请', n;
END $$;

-- ② 聊天家族：会话已不在、子行还在的。五张表全部扫一遍（理由见文件头 ② 那一段）。
--    语义与 `delete_conversation` 的级联删**完全一致**：这五张表都按 `conversation_id` 读，
--    会话没了就再也没有任何读取路径 ⇒ 留着只会永久占表。
--    `chat_image` 不在这里：它挂着 `chat_history` 的**真外键**（`ON DELETE CASCADE`），
--    删上面那行 `chat_history` 时它自己会跟着走。
DO $$
DECLARE n int; total int := 0;
BEGIN
  DELETE FROM "chat_history"   c WHERE NOT EXISTS (SELECT 1 FROM "conversation" v WHERE v.id = c.conversation_id);
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n; RAISE NOTICE '② chat_history：删了 % 行', n;

  DELETE FROM "chat_summary"   c WHERE NOT EXISTS (SELECT 1 FROM "conversation" v WHERE v.id = c.conversation_id);
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n; RAISE NOTICE '② chat_summary：删了 % 行', n;

  DELETE FROM "execution_log"  c WHERE NOT EXISTS (SELECT 1 FROM "conversation" v WHERE v.id = c.conversation_id);
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n; RAISE NOTICE '② execution_log：删了 % 行', n;

  DELETE FROM "pending_action" c WHERE NOT EXISTS (SELECT 1 FROM "conversation" v WHERE v.id = c.conversation_id);
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n; RAISE NOTICE '② pending_action：删了 % 行', n;

  DELETE FROM "agent_task"     c WHERE NOT EXISTS (SELECT 1 FROM "conversation" v WHERE v.id = c.conversation_id);
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n; RAISE NOTICE '② agent_task：删了 % 行', n;

  RAISE NOTICE '② 聊天家族合计删了 % 行', total;
END $$;

-- 跑完自查（**人工**跑一次）：
--
--   SELECT count(*) FROM quota_request q
--     LEFT JOIN "user" u ON u.id = q.user_id WHERE u.id IS NULL;            -- 期望 0
--   SELECT count(*) FROM chat_history c
--     LEFT JOIN conversation v ON v.id = c.conversation_id WHERE v.id IS NULL; -- 期望 0
--
-- ⚠️ 本文件在 CI 里按构造是**空真**的（CI 的库是从 `0000` + 清单现建的，本来就没有孤儿行，
-- 所有 DELETE 都是 no-op）⇒ **别声称它"被测过"**。它唯一的判据就是上面这两条产线自查。
