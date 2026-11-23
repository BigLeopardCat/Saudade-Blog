CREATE TABLE IF NOT EXISTS support_case (
    id serial PRIMARY KEY,
    owner_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    opening_id varchar(36) NOT NULL,
    kind text NOT NULL CHECK (kind IN ('question', 'ticket')),
    subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
    status text NOT NULL DEFAULT 'waiting_staff'
        CHECK (status IN ('waiting_staff', 'waiting_user', 'resolved')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, opening_id)
);

CREATE INDEX IF NOT EXISTS support_case_owner_id_idx ON support_case(owner_id, id DESC);
CREATE INDEX IF NOT EXISTS support_case_status_id_idx ON support_case(status, id DESC);

CREATE TABLE IF NOT EXISTS support_event (
    id serial PRIMARY KEY,
    case_id integer NOT NULL REFERENCES support_case(id) ON DELETE CASCADE,
    actor_id integer REFERENCES "user"(id) ON DELETE SET NULL,
    sender text NOT NULL CHECK (sender IN ('customer', 'staff')),
    action text NOT NULL CHECK (action IN ('open_question', 'open_ticket', 'reply', 'escalate', 'resolve', 'reopen')),
    body text NOT NULL CHECK (char_length(body) <= 4000),
    request_id varchar(36) NOT NULL,
    base_version integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, actor_id, request_id)
);

CREATE INDEX IF NOT EXISTS support_event_case_id_idx ON support_event(case_id, id DESC);
CREATE INDEX IF NOT EXISTS support_event_actor_id_idx ON support_event(actor_id);

CREATE TABLE IF NOT EXISTS support_guidance (
    case_id integer PRIMARY KEY REFERENCES support_case(id) ON DELETE CASCADE,
    topic_id text CHECK (topic_id ~ '^[a-z][a-z0-9-]{0,63}$')
);

CREATE OR REPLACE VIEW support_assistant_queue WITH (security_barrier = true) AS
SELECT c.id AS case_id, c.owner_id, c.subject, e.body
FROM support_case c
JOIN support_event e ON e.case_id = c.id AND e.action = 'open_question'
WHERE c.kind = 'question' AND c.version = 1 AND c.status = 'waiting_staff'
  AND NOT EXISTS (SELECT 1 FROM support_guidance g WHERE g.case_id = c.id);

-- The worker can record one suggested topic on an untouched question. A human taking
-- the case wins the same row lock as a normal reply, escalation or resolution.
CREATE OR REPLACE FUNCTION support_record_guidance(target integer, topic text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM 1 FROM public.support_case
    WHERE id = target AND kind = 'question' AND version = 1 AND status = 'waiting_staff'
    FOR UPDATE;
    IF FOUND THEN
        INSERT INTO public.support_guidance (case_id, topic_id) VALUES (target, topic)
        ON CONFLICT (case_id) DO NOTHING;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION support_record_guidance(integer, text) FROM PUBLIC;
