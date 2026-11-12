-- Shared descending traversal for the homepage and archive, including timestamp ties.
CREATE INDEX IF NOT EXISTS idx_note_feed_order ON note (created_at DESC, id DESC);
