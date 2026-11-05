-- The receipt and business effect commit in the same transaction.
CREATE TABLE IF NOT EXISTS automation_change_delivery (
    owner_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    run_id varchar(200) NOT NULL,
    payload_hash varchar(64) NOT NULL,
    outcome jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(owner_id, run_id)
);
