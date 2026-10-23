-- 摘要覆盖边界使用消息主键；历史保留数量不能表示摘要进度。
-- 存量摘要从 0 开始，下一次普通对话按新边界刷新。
ALTER TABLE chat_summary
    ADD COLUMN IF NOT EXISTS covered_through_id integer NOT NULL DEFAULT 0;
