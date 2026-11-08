-- Bound FK lookups when deleting chat messages, gallery images or generation jobs.
CREATE INDEX IF NOT EXISTS chat_task_input_message
    ON chat_task_input(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_generation_image
    ON image_generation(image_id) WHERE image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_generation_retry
    ON image_generation(retry_of) WHERE retry_of IS NOT NULL;
