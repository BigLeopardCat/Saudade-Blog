-- Confirmation recovery must retain every field shown before approval.
BEGIN;
ALTER TABLE pending_action ALTER COLUMN question TYPE text;
COMMENT ON COLUMN pending_action.question IS
    'Complete confirmation question; application limit 32768 characters, never truncated';
COMMENT ON COLUMN pending_action.args IS
    'Complete specs JSON for audit; application limit 32768 characters, never truncated';
COMMIT;
