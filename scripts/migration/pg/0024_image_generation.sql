CREATE TABLE IF NOT EXISTS image_generation (
    id uuid PRIMARY KEY,
    owner_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    request jsonb NOT NULL,
    request_hash varchar(64) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','generating','review','accepted','rejected','failed','unknown')),
    created_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz,
    finished_at timestamptz,
    output bytea,
    output_hash varchar(64),
    usage jsonb,
    error varchar(200),
    image_id integer REFERENCES images(image_key) ON DELETE SET NULL,
    reviewed_at timestamptz,
    CHECK (output IS NULL OR octet_length(output) <= 20971520)
);
CREATE INDEX IF NOT EXISTS image_generation_owner_created ON image_generation(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS image_generation_reference (
    job_id uuid NOT NULL REFERENCES image_generation(id) ON DELETE CASCADE,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
    bytes bytea NOT NULL CHECK (octet_length(bytes) <= 10485760),
    mime varchar(30) NOT NULL,
    PRIMARY KEY (job_id,ordinal)
);
