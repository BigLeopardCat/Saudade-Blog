-- Completion reports belong to the conversation that proposed the image job.
ALTER TABLE image_generation
    ADD COLUMN conversation_id integer REFERENCES conversation(id) ON DELETE SET NULL,
    ADD COLUMN reported_version varchar(64),
    ADD COLUMN save_storage varchar(8) NOT NULL DEFAULT 'local'
        CHECK (save_storage IN ('local', 'r2'));
CREATE INDEX image_generation_conversation
    ON image_generation(owner_id, conversation_id, created_at DESC)
    WHERE conversation_id IS NOT NULL;
