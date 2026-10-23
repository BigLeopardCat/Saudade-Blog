-- Reject conflicting category identities for all writers, including legacy clients.
-- Existing duplicates must be resolved explicitly; this migration never rewrites data.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX IF NOT EXISTS category_name_unique ON category (name);
CREATE UNIQUE INDEX IF NOT EXISTS category_path_unique ON category (path_name)
    WHERE path_name IS NOT NULL AND path_name <> '';
COMMIT;
