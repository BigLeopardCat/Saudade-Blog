-- The receipt survives later announcement edits/deletion; never expires an operation into reexecution.
CREATE TABLE IF NOT EXISTS announcement_operation (
    owner_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    operation_id varchar(64) NOT NULL CHECK (operation_id ~ '^[0-9a-f]{64}$'),
    request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    outcome jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, operation_id)
);
