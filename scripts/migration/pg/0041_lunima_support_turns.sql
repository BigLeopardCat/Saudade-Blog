BEGIN;
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.support_event DROP CONSTRAINT IF EXISTS support_event_sender_check;
ALTER TABLE public.support_event ADD CONSTRAINT support_event_sender_check
    CHECK (sender IN ('customer', 'staff', 'assistant'));

-- One assistant message per customer turn, including the durable handoff receipt.
ALTER TABLE public.support_event ADD COLUMN IF NOT EXISTS source_event_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS support_assistant_source_idx
    ON public.support_event(source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_pending_question_idx
    ON public.support_case(id) WHERE kind = 'question' AND status = 'waiting_staff';

CREATE OR REPLACE VIEW public.support_pending_turn WITH (security_barrier = true) AS
SELECT c.id AS case_id, c.owner_id, c.subject, c.version, recent.id AS event_id,
       recent.body, recent.created_at,
       (SELECT count(*) FROM public.support_event counted
        WHERE counted.case_id = c.id AND counted.sender = 'assistant') AS prior_answers,
       (SELECT jsonb_agg(jsonb_build_object('sender', h.sender, 'body', h.body) ORDER BY h.id)
        FROM (SELECT id, sender, body FROM public.support_event
              WHERE case_id = c.id AND action IN ('open_question', 'reply')
              ORDER BY id DESC LIMIT 7) h) AS history
FROM public.support_case c
JOIN LATERAL (
    SELECT id, sender, action, body, created_at
    FROM public.support_event WHERE case_id = c.id ORDER BY id DESC LIMIT 1
) recent ON recent.sender = 'customer' AND recent.action IN ('open_question', 'reply')
WHERE c.kind = 'question' AND c.status = 'waiting_staff'
  AND NOT EXISTS (SELECT 1 FROM public.support_event h
      WHERE h.case_id = c.id AND h.sender = 'staff');

CREATE OR REPLACE FUNCTION public.support_publish_assistant(
    target integer, source integer, expected_version integer, reply_text text, handoff boolean
) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF reply_text IS NULL OR char_length(reply_text) NOT BETWEEN 1 AND 3000 OR handoff IS NULL THEN
        RAISE EXCEPTION 'invalid assistant response' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.support_case WHERE id = target FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM public.support_event WHERE source_event_id = source AND case_id = target) THEN
        RETURN true;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.support_pending_turn
        WHERE case_id = target AND event_id = source AND version = expected_version) THEN
        RETURN false;
    END IF;
    UPDATE public.support_case SET
        kind = CASE WHEN handoff THEN 'ticket' ELSE 'question' END,
        status = CASE WHEN handoff THEN 'waiting_staff' ELSE 'waiting_user' END,
        version = version + 1, updated_at = clock_timestamp()
        WHERE id = target;
    INSERT INTO public.support_event(case_id, sender, action, body, request_id, base_version, source_event_id)
        VALUES (target, 'assistant', CASE WHEN handoff THEN 'escalate' ELSE 'reply' END,
                reply_text, gen_random_uuid()::text, expected_version, source);
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.support_publish_assistant(integer, integer, integer, text, boolean) FROM PUBLIC;
COMMIT;
