BEGIN;
CREATE TABLE IF NOT EXISTS image_location (
    image_id integer PRIMARY KEY REFERENCES images(image_key) ON DELETE CASCADE,
    source_url text UNIQUE,
    location jsonb NOT NULL CHECK (location->>'storage' IN ('local','r2'))
);
CREATE TABLE IF NOT EXISTS image_transfer (
    id text PRIMARY KEY CHECK (length(id)=64),
    requested_by integer NOT NULL REFERENCES "user"(id),
    spec jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','copying','published','complete','failed')),
    lease uuid,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    result jsonb,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS image_transfer_due ON image_transfer(next_attempt_at) WHERE finished_at IS NULL;
COMMIT;
