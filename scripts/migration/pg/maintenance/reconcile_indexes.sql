\set ON_ERROR_STOP on
-- Run outside a transaction; this is the online counterpart of 0010 and 0031.
SET lock_timeout = '2s';
SET statement_timeout = '120s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_history_user_latest
    ON public.chat_history(user_id, id DESC) INCLUDE (conversation_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_task_input_message
    ON public.chat_task_input(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS image_generation_image
    ON public.image_generation(image_id) WHERE image_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS image_generation_retry
    ON public.image_generation(retry_of) WHERE retry_of IS NOT NULL;
-- Verify the complete CI contract afterwards. IF NOT EXISTS cannot certify an existing definition.
