BEGIN;

-- Install both the projection and its triggers against one committed note snapshot.
LOCK TABLE public.note IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.rag_corpus_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation uuid NOT NULL DEFAULT gen_random_uuid(),
    document_count bigint NOT NULL CHECK (document_count >= 0)
);
CREATE TABLE IF NOT EXISTS public.rag_corpus_document (
    id integer PRIMARY KEY,
    revision bytea NOT NULL CHECK (octet_length(revision) = 32),
    escaped_text_bytes integer NOT NULL CHECK (escaped_text_bytes >= 0)
);

-- Keep membership aligned with notes::public_condition on the read boundary.
CREATE OR REPLACE FUNCTION public.rag_corpus_visible(flag boolean, status text, draft_of integer)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT flag IS TRUE AND (status IN ('public', 'published')) IS TRUE AND draft_of IS NULL
$$;

-- Both fields use the exact UTF-8 wire encoding of the compact [title,content] pair.
CREATE OR REPLACE FUNCTION public.rag_corpus_entry(title text, content text)
RETURNS TABLE (revision bytea, escaped_text_bytes integer)
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    payload bytea := convert_to('[' || to_json(title)::text || ',' || to_json(content)::text || ']', 'UTF8');
BEGIN
    RETURN QUERY SELECT sha256(payload), octet_length(payload) - 7;
END
$$;

DO $$
DECLARE
    loaded bigint;
BEGIN
    IF NOT EXISTS (SELECT FROM public.rag_corpus_state WHERE singleton) THEN
        INSERT INTO public.rag_corpus_document (id, revision, escaped_text_bytes)
        SELECT n.id, e.revision, e.escaped_text_bytes FROM public.note n
        CROSS JOIN LATERAL public.rag_corpus_entry(n.title, n.content) e
        WHERE public.rag_corpus_visible(n.is_public, n.status, n.draft_of);
        GET DIAGNOSTICS loaded = ROW_COUNT;
        INSERT INTO public.rag_corpus_state (document_count) VALUES (loaded);
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_corpus_note_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    was_visible boolean := false;
    is_visible boolean := false;
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        DELETE FROM public.rag_corpus_document;
        IF FOUND THEN
            UPDATE public.rag_corpus_state SET generation = DEFAULT, document_count = 0 WHERE singleton;
            IF NOT FOUND THEN RAISE EXCEPTION 'missing public corpus state'; END IF;
        END IF;
        RETURN NULL;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        was_visible := public.rag_corpus_visible(OLD.is_public, OLD.status, OLD.draft_of);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        is_visible := public.rag_corpus_visible(NEW.is_public, NEW.status, NEW.draft_of);
    END IF;
    IF NOT was_visible AND NOT is_visible THEN RETURN NULL; END IF;
    IF was_visible AND is_visible THEN
        IF OLD.id = NEW.id AND OLD.title = NEW.title AND OLD.content = NEW.content THEN
            RETURN NULL;
        END IF;
    END IF;

    IF was_visible AND (NOT is_visible OR OLD.id <> NEW.id) THEN
        DELETE FROM public.rag_corpus_document WHERE id = OLD.id;
    END IF;
    IF is_visible THEN
        INSERT INTO public.rag_corpus_document (id, revision, escaped_text_bytes)
        SELECT NEW.id, e.revision, e.escaped_text_bytes
        FROM public.rag_corpus_entry(NEW.title, NEW.content) e
        ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision,
            escaped_text_bytes = EXCLUDED.escaped_text_bytes;
    END IF;
    UPDATE public.rag_corpus_state
    SET generation = DEFAULT, document_count = document_count + is_visible::int - was_visible::int
    WHERE singleton;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing public corpus state'; END IF;
    RETURN NULL;
END
$$;

CREATE OR REPLACE TRIGGER rag_corpus_note_change
AFTER INSERT OR DELETE OR UPDATE OF id, title, content, is_public, status, draft_of ON public.note
FOR EACH ROW EXECUTE FUNCTION public.rag_corpus_note_changed();

CREATE OR REPLACE TRIGGER rag_corpus_note_truncate
AFTER TRUNCATE ON public.note FOR EACH STATEMENT EXECUTE FUNCTION public.rag_corpus_note_changed();

COMMIT;
