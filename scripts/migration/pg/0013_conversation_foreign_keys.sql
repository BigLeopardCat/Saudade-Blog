-- 聊天派生记录与会话一起删除；迟到的回复、摘要和回执不得重新创建孤儿记录。
-- ADD CONSTRAINT 会验证存量，存在孤儿时迁移失败，不自动删除任何历史数据。
DO $$
DECLARE relation_name text;
DECLARE constraint_name text;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY['chat_history','chat_summary','execution_log','pending_action','agent_task']
    LOOP
        constraint_name := 'fk_' || relation_name || '_conversation';
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conrelid=relation_name::regclass AND conname=constraint_name) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE',
                           relation_name,constraint_name);
        END IF;
    END LOOP;
END $$;
