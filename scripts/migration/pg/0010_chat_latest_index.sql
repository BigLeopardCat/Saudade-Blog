-- 默认会话解析：WHERE user_id=? ORDER BY id DESC LIMIT 1，只取 conversation_id。
-- 避免对老用户倒扫全站主键，或先加载该用户全部 id 再排序。
-- 生产大表可在事务之外使用 CREATE INDEX CONCURRENTLY 创建同名索引；
-- 下面是供全新建库/维护窗口使用的形式，不删除现有索引。
CREATE INDEX IF NOT EXISTS idx_chat_history_user_latest
    ON chat_history (user_id, id DESC) INCLUDE (conversation_id);
