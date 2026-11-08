\set ON_ERROR_STOP on
-- Refresh planner statistics after schema changes/imports, without rewriting tables.
SET lock_timeout = '1s';
SET statement_timeout = '30s';
SELECT format('ANALYZE %I.%I;', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY pg_relation_size(c.oid),c.relname
\gexec
