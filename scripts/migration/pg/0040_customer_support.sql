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
