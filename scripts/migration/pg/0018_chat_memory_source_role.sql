-- 只记录产生当时核实的角色；旧行保留 NULL，不能按账号当前角色推断历史来源。
BEGIN;

ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS source_role varchar(32);
ALTER TABLE chat_summary ADD COLUMN IF NOT EXISTS source_role varchar(32);

DO $$
DECLARE relation_name text;
DECLARE constraint_name text;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY['chat_history', 'chat_summary']
    LOOP
        constraint_name := 'ck_' || relation_name || '_source_role';
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conrelid = relation_name::regclass AND conname = constraint_name) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I CHECK (source_role IN (''admin'', ''superadmin'', ''user'', ''zako''))',
                relation_name, constraint_name);
        END IF;
    END LOOP;
END $$;

-- 供角色隔离后的会话消息按主键增量读取；NULL 来源不进入模型上下文。
CREATE INDEX IF NOT EXISTS idx_chat_history_source_cursor
    ON chat_history (user_id, conversation_id, source_role, id)
    WHERE source_role IS NOT NULL;

COMMIT;
