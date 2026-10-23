-- Link notification copies to their announcement independently of editable text.
BEGIN;
ALTER TABLE user_notification
    ADD COLUMN IF NOT EXISTS announcement_id integer
    REFERENCES announcement(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notification_announcement
    ON user_notification(announcement_id) WHERE announcement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_announcement_user
    ON user_notification(announcement_id, user_id) WHERE announcement_id IS NOT NULL;

-- Preserve ambiguous historical copies unlinked instead of guessing ownership.
WITH candidates AS (
    SELECT n.id, min(a.id) AS announcement_id
    FROM user_notification n
    JOIN announcement a ON a.title = n.title AND a.created_at = n.created_at
        AND a.content = n.content
    WHERE n.type = 'announcement' AND n.announcement_id IS NULL
    GROUP BY n.id HAVING count(*) = 1
), unique_copies AS (
    SELECT c.id, c.announcement_id
    FROM candidates c JOIN user_notification n ON n.id = c.id
    WHERE NOT EXISTS (
        SELECT 1 FROM candidates other
        JOIN user_notification copy ON copy.id = other.id
        WHERE other.announcement_id = c.announcement_id
            AND copy.user_id = n.user_id AND other.id <> c.id
    ) AND NOT EXISTS (
        SELECT 1 FROM user_notification linked
        WHERE linked.announcement_id = c.announcement_id AND linked.user_id = n.user_id
    )
)
UPDATE user_notification n SET announcement_id = c.announcement_id
FROM unique_copies c WHERE n.id = c.id;
COMMIT;
