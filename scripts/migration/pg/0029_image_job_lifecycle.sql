ALTER TABLE image_generation
    ADD COLUMN IF NOT EXISTS origin varchar(16) NOT NULL DEFAULT 'dashboard',
    ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES image_generation(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS retry_source_status varchar(16);
ALTER TABLE image_generation DROP CONSTRAINT IF EXISTS image_generation_status_check;
ALTER TABLE image_generation ADD CONSTRAINT image_generation_status_check
    CHECK (status IN ('pending','generating','review','saving','accepted','rejected','failed','unknown'));
ALTER TABLE image_generation DROP CONSTRAINT IF EXISTS image_generation_origin_check;
ALTER TABLE image_generation ADD CONSTRAINT image_generation_origin_check
    CHECK (origin IN ('dashboard','agent'));
