-- Preserve delivery identity even when the published announcement is later deleted.
CREATE TABLE IF NOT EXISTS automation_announcement_delivery (
    owner_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    run_id varchar(200) NOT NULL,
    payload_hash varchar(64) NOT NULL,
    announcement_id integer REFERENCES announcement(id) ON DELETE SET NULL,
    notification_count bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, run_id)
);
CREATE INDEX IF NOT EXISTS automation_announcement_delivery_idx
    ON automation_announcement_delivery (announcement_id) WHERE announcement_id IS NOT NULL;
