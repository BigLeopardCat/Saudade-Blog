-- An execution may retry delivery; its owner and payload remain bound after deletion.
CREATE TABLE IF NOT EXISTS automation_result_delivery (
    owner_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    run_id varchar(200) NOT NULL,
    payload_hash varchar(64) NOT NULL,
    notification_id integer REFERENCES user_notification(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, run_id)
);
CREATE INDEX IF NOT EXISTS automation_result_notification_idx
    ON automation_result_delivery (notification_id) WHERE notification_id IS NOT NULL;
