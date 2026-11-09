-- Transport admission only; DBOS owns execution state and LangGraph owns task state.
CREATE TABLE IF NOT EXISTS chat_run_claim (
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    run_id VARCHAR(32) NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_run_claim_created ON chat_run_claim(user_id, created_at);
