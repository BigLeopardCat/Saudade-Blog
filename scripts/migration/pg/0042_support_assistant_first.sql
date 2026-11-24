BEGIN;
SET LOCAL lock_timeout = '2s';

-- Ownership of the next response is independent of whether the user filed a ticket.
ALTER TABLE public.support_case ADD COLUMN IF NOT EXISTS assignee text NOT NULL DEFAULT 'staff'
    CHECK (assignee IN ('assistant', 'staff'));

-- Preserve explicitly escalated and staff-handled records. Unreviewed direct tickets and
-- ongoing automated questions can join the assistant queue without losing their history.
UPDATE public.support_case c SET assignee = 'assistant',
    status = CASE WHEN (SELECT e.action FROM public.support_event e
        WHERE e.case_id = c.id ORDER BY e.id DESC LIMIT 1) = 'reopen'
        THEN 'waiting_user' ELSE c.status END
WHERE c.assignee = 'staff' AND c.status <> 'resolved'
  AND NOT EXISTS (SELECT 1 FROM public.support_event e
      WHERE e.case_id = c.id AND (e.sender = 'staff' OR e.action = 'escalate'))
  AND NOT EXISTS (SELECT 1 FROM public.support_guidance g WHERE g.case_id = c.id AND g.topic_id IS NULL);

ALTER TABLE public.support_case ALTER COLUMN assignee SET DEFAULT 'assistant';
DROP INDEX IF EXISTS public.support_pending_question_idx;
CREATE INDEX IF NOT EXISTS support_pending_assistant_idx
    ON public.support_case(id) WHERE assignee = 'assistant' AND status = 'waiting_staff';
CREATE INDEX IF NOT EXISTS support_staff_queue_idx
    ON public.support_case(id DESC) WHERE assignee = 'staff';

CREATE OR REPLACE VIEW public.support_pending_turn WITH (security_barrier = true) AS
SELECT c.id AS case_id, c.owner_id, c.subject, c.version, recent.id AS event_id,
       recent.body, recent.created_at,
       (SELECT count(*) FROM public.support_event e
        WHERE e.case_id = c.id AND e.sender = 'assistant') AS prior_answers,
       (SELECT jsonb_agg(jsonb_build_object('sender', h.sender, 'body', h.body) ORDER BY h.id)
        FROM (SELECT id, sender, body FROM public.support_event
              WHERE case_id = c.id AND action IN ('open_question', 'open_ticket', 'reply')
              ORDER BY id DESC LIMIT 7) h) AS history
FROM public.support_case c
JOIN LATERAL (
    SELECT id, sender, action, body, created_at
    FROM public.support_event WHERE case_id = c.id ORDER BY id DESC LIMIT 1
) recent ON recent.sender = 'customer' AND recent.action IN ('open_question', 'open_ticket', 'reply')
WHERE c.assignee = 'assistant' AND c.status = 'waiting_staff';

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
        kind = CASE WHEN handoff THEN 'ticket' ELSE kind END,
        assignee = CASE WHEN handoff THEN 'staff' ELSE assignee END,
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
