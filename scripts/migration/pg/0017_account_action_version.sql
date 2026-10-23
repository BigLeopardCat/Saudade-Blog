-- Account confirmation versions survive ABA changes through every writer, including legacy routes.
-- Does not invalidate plans for quota usage, avatars or passwords (password reset bumps token_version).
BEGIN;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS account_action_version bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION bump_account_action_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.username, NEW.role, NEW.status, NEW.token_version, NEW.muted_until)
       IS DISTINCT FROM ROW(OLD.username, OLD.role, OLD.status, OLD.token_version, OLD.muted_until) THEN
        NEW.account_action_version := OLD.account_action_version + 1;
    ELSE
        NEW.account_action_version := OLD.account_action_version;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_action_version ON "user";
CREATE TRIGGER account_action_version BEFORE UPDATE ON "user"
FOR EACH ROW EXECUTE FUNCTION bump_account_action_version();
COMMIT;
