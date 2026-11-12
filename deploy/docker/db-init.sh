#!/usr/bin/env bash
# The official PostgreSQL entrypoint runs this only for an empty named data volume.
set -euo pipefail
psql -X --no-password --username "$POSTGRES_USER" --dbname postgres -v ON_ERROR_STOP=1 <<'SQL'
\getenv app_password SAUDADE_APP_PASSWORD
\getenv agent_password SAUDADE_AGENT_PASSWORD
CREATE ROLE saudade_owner NOLOGIN;
SELECT format('CREATE ROLE saudade_app LOGIN PASSWORD %L', :'app_password') \gexec
SELECT format('CREATE ROLE saudade_agent LOGIN PASSWORD %L', :'agent_password') \gexec
CREATE DATABASE saudade_blog OWNER saudade_owner;
CREATE DATABASE saudade_agent OWNER saudade_agent;
REVOKE ALL ON DATABASE saudade_blog FROM PUBLIC;
GRANT CONNECT ON DATABASE saudade_blog TO saudade_app;
REVOKE ALL ON DATABASE saudade_agent FROM PUBLIC;
ALTER DATABASE saudade_blog SET timezone TO 'Asia/Shanghai';
ALTER DATABASE saudade_agent SET timezone TO 'UTC';
\connect saudade_blog
SET ROLE saudade_owner;
\i /bootstrap/schema.sql
GRANT USAGE ON SCHEMA public TO saudade_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO saudade_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO saudade_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saudade_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saudade_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saudade_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO saudade_app;
SQL
