-- 与会话删除同事务提交，跨服务清理失败可重试；没有外键，以便删除账号后继续交付。
CREATE TABLE IF NOT EXISTS agent_checkpoint_cleanup (
    conversation_id integer PRIMARY KEY,
    user_id integer NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error varchar(80)
);
CREATE INDEX IF NOT EXISTS agent_checkpoint_cleanup_due
    ON agent_checkpoint_cleanup(next_attempt_at);
