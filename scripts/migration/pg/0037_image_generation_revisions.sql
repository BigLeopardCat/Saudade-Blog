ALTER TABLE image_generation ADD COLUMN IF NOT EXISTS revised_from uuid
    REFERENCES image_generation(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS image_generation_revised_from_uq
    ON image_generation(revised_from) WHERE revised_from IS NOT NULL;
