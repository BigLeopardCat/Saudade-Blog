BEGIN;
ALTER TABLE image_location ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS image_location_public_id ON image_location(public_id);
COMMIT;
