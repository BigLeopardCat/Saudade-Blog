-- Completed background work is durable until its owning conversation is deleted.
CREATE TABLE IF NOT EXISTS chat_task_result (
    owner_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    run_id varchar(200) NOT NULL,
    conversation_id integer NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    schedule_id varchar(35) NOT NULL,
    title varchar(80) NOT NULL,
    content text NOT NULL,
    status varchar(20) NOT NULL CHECK (status IN ('completed','incomplete','failed','unknown')),
    event_version varchar(64) NOT NULL,
    reported_version varchar(64),
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, run_id)
);
CREATE INDEX IF NOT EXISTS chat_task_result_unread_idx
    ON chat_task_result(owner_id, conversation_id, created_at) WHERE read_at IS NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='image_generation'
        AND column_name='read_version') THEN
        ALTER TABLE image_generation ADD COLUMN read_version varchar(64);
        -- Backfill once; replaying the migration must not mark later messages read.
        UPDATE image_generation SET read_version=reported_version
            WHERE reported_version IS NOT NULL;
    END IF;
END $$;
