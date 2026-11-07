ALTER TABLE images ALTER COLUMN image_url TYPE text;
ALTER TABLE note ALTER COLUMN cover TYPE text;
DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='images_url_size' AND conrelid='images'::regclass) THEN
        ALTER TABLE images ADD CONSTRAINT images_url_size CHECK (octet_length(image_url) BETWEEN 1 AND 2048);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='note_cover_size' AND conrelid='note'::regclass) THEN
        ALTER TABLE note ADD CONSTRAINT note_cover_size CHECK (octet_length(cover) <= 2048);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS image_deletion (
    image_id integer PRIMARY KEY REFERENCES images(image_key) ON DELETE RESTRICT,
    image_url text NOT NULL CHECK (image_url <> ''),
    decoded_url text NOT NULL CHECK (decoded_url <> ''),
    requested_by integer NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    storage_kind text NOT NULL CHECK (storage_kind IN ('local', 'r2')),
    storage_scope text NOT NULL,
    storage_bucket text,
    storage_key text NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at timestamptz,
    last_error text,
    CHECK ((storage_kind = 'local' AND storage_bucket IS NULL)
        OR (storage_kind = 'r2' AND storage_bucket IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS image_deletion_due
    ON image_deletion (next_attempt_at, image_id) WHERE finished_at IS NULL;
