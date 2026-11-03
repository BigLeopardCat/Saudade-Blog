BEGIN;
ALTER TABLE note ADD COLUMN IF NOT EXISTS cover_fit text
    CHECK (cover_fit IN ('cover', 'contain'));
ALTER TABLE note ADD COLUMN IF NOT EXISTS carousel_fit text
    CHECK (carousel_fit IN ('cover', 'contain'));
COMMIT;
