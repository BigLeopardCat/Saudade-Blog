-- Request identity survives network retries; cleanup is committed with history deletion.
BEGIN;
ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS task_id varchar(100);
CREATE UNIQUE INDEX IF NOT EXISTS chat_history_user_task
    ON chat_history(user_id,conversation_id,task_id) WHERE role='user' AND task_id IS NOT NULL;
ALTER TABLE agent_checkpoint_cleanup ADD COLUMN IF NOT EXISTS task_id varchar(100) NOT NULL DEFAULT '';
ALTER TABLE agent_checkpoint_cleanup ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
CREATE INDEX IF NOT EXISTS agent_checkpoint_cleanup_pending ON agent_checkpoint_cleanup(next_attempt_at)
    WHERE delivered_at IS NULL;
DROP INDEX IF EXISTS agent_checkpoint_cleanup_due;
ALTER TABLE agent_checkpoint_cleanup DROP CONSTRAINT IF EXISTS agent_checkpoint_cleanup_pkey;
ALTER TABLE agent_checkpoint_cleanup ADD PRIMARY KEY(conversation_id,task_id);
COMMIT;
