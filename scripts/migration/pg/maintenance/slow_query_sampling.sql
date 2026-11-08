\set ON_ERROR_STOP on
\if :{?app_role}
\else
    \echo 'Pass -v app_role=APPLICATION_ROLE and -v app_database=BLOG_DATABASE'
    DO $$ BEGIN RAISE EXCEPTION 'Required psql variables are missing'; END $$;
\endif
\if :{?app_database}
\else
    \echo 'Pass -v app_database=BLOG_DATABASE'
    DO $$ BEGIN RAISE EXCEPTION 'Required psql variables are missing'; END $$;
\endif
-- Superuser operation, scoped to one role/database; effective on subsequent logins.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
ALTER ROLE :"app_role" IN DATABASE :"app_database" SET log_parameter_max_length=0;
ALTER ROLE :"app_role" IN DATABASE :"app_database" SET log_parameter_max_length_on_error=0;
ALTER ROLE :"app_role" IN DATABASE :"app_database" SET log_min_duration_sample='250ms';
ALTER ROLE :"app_role" IN DATABASE :"app_database" SET log_statement_sample_rate=0.1;
COMMIT;
