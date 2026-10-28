-- Personal deletion preserves the other participant's copy and announcement source.
ALTER TABLE user_notification ADD COLUMN IF NOT EXISTS deleted_at timestamp;
ALTER TABLE user_message ADD COLUMN IF NOT EXISTS sender_deleted_at timestamp;
ALTER TABLE user_message ADD COLUMN IF NOT EXISTS recipient_deleted_at timestamp;
