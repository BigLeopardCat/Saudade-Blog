-- 孤儿行清理（20261018）。
--
-- 跑法（**以应用角色跑**；理由见 `0003_chat_image.sql` 末节）：
--   psql -h 127.0.0.1 -U saudade_app -d saudade_blog -X -v ON_ERROR_STOP=1 -f - < 本文件
-- 可反复跑（第二次跑影响 0 行）。**但跑之前必须先跑下面那两条预检并人眼过一遍。**
--
-- ── 治的是什么 ─────────────────────────────────────────────────────────────
-- 20261018 全库扫了一遍"app 级关系"（schema 里那 13 条外键之外、靠应用代码维护的那些），
-- 只有两处有孤儿，一共 6 行：
--
--   ① `quota_request` 5 行：申请人已经不在 `user` 表里了。申请人没了 ⇒ 没人会批准，
--      批准了也没有收款人；留着只是后台申请列表里的**幽灵申请**（点进去 404）。
--   ② `chat_history` 1 行（id 4209，user 1，`conversation_id = 171`）：那个会话已经不在了。
--
-- ②这一条背后是一个**代码缺陷**，不只是数据脏：`temp_user.rs::delete_temp_user` 删账号时
-- 只清了 `chat_history` / `chat_summary` / `conversation` **三张**，而 `delete_conversation`
-- 清的是**五张**（还含 `execution_log` / `pending_action` / `agent_task`）。所以
-- **20261018 起那个缺陷已修**（两份清单收成一处 `conversation::purge_conversation_data`，
-- 并有行为判据 `tests/pg_integration.rs` 钉着"六张表全空"）。本文件负责清掉它**已经留下**
-- 的残渣 —— 所以下面按 `NOT EXISTS` 把**五张子表**都扫一遍，而不是只删报出来的那一条。
--
-- ── 为什么不用 `DELETE FROM … WHERE id IN (…)` 写死 id ──────────────────────
-- 写死 id 的迁移在别的库上（测试库、重放的快照）是错的，而**它不会报错**：删 0 行照样绿。
-- `NOT EXISTS` 是数据驱动的，在哪个库上都只删真正是孤儿的行，且天然幂等。
--
-- ── 保守协议（**照做**）─────────────────────────────────────────────────────
-- 先跑这两条，把结果看一遍；**若列出的东西与下面写的不一样，停下来看，别接着跑**：
--
--   -- 预检 A：申请人已不在 user 里的额度申请。期望 5 行（user_id 在 5,6,7,8,9,11,13 那一带）
--   SELECT q.id, q.user_id, q.status FROM quota_request q
--     LEFT JOIN "user" u ON u.id = q.user_id WHERE u.id IS NULL ORDER BY q.id;
--
--   -- 预检 B：会话已不在的聊天行。期望**只有一个** conversation_id：171
--   SELECT DISTINCT conversation_id FROM chat_history
--    WHERE conversation_id NOT IN (SELECT id FROM conversation) ORDER BY 1;
--
-- ⚠️ 预检 B 若列出**不止一个** conversation_id，说明还有别的泄漏路径没查出来 —— 先查清
-- 再删，不要"顺手清干净"（那样会把一个还在发生的缺陷当成一次性脏数据处理掉）。

-- ① 额度申请：申请人已不在 `user` 表里。
--    `quota_request` **没有** user 外键（全项目"实体零关系"惯例），所以这个孤儿是
--    结构上允许的 —— 本迁移只清存量，不改结构（加外键会改 `verify_parity.py` 的外键集合）。
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
