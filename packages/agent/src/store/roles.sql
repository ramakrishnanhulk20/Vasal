-- Run by the operator, once, on Neon, connected as the database owner, after
-- migrate has created the tables. Never run on PGlite.
--
-- Create this role here in SQL, not in the Neon console. Roles made in the
-- console, CLI or API join neon_superuser and can create roles, databases and
-- more. A role made in SQL holds only what is granted below.
--
-- No password lives in this file. Afterwards, set one from psql with
-- \password vasal_app (it is sent hashed) and give the web and agent servers
-- the vasal_app connection string, never the owner's.
--
-- What the app role cannot do, by design (C6.6): change the schema, write the
-- kill switch, or delete rows. Pruning expired rows and setting caps or flags
-- are operator jobs run as the owner. Postgres 15 and later give PUBLIC no
-- CREATE on schema public, so this role cannot add tables either; on an older
-- server, revoke that first.

CREATE ROLE vasal_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vasal_app;

-- Column-level UPDATE on usage_buckets: the app may count usage but never
-- raise a cap or move a window. INSERT stays, because per-second buckets are
-- created on demand; an existing bucket's cap cannot change through it (the
-- insert does nothing on conflict). setBucket is an operator job.
GRANT SELECT, INSERT ON usage_buckets TO vasal_app;
GRANT UPDATE (used) ON usage_buckets TO vasal_app;

GRANT SELECT, INSERT ON qloo_cache, visitor_counters TO vasal_app;
GRANT UPDATE (body, fetched_at, expires_at) ON qloo_cache TO vasal_app;
GRANT UPDATE (runs) ON visitor_counters TO vasal_app;

GRANT SELECT ON app_flags TO vasal_app;

-- Runs are append only for the app: it can read and add rows, and on runs it
-- can move only the status fields. There is no DELETE grant on any run table.
GRANT SELECT, INSERT ON runs, run_events, run_candidates, run_board, run_briefs TO vasal_app;
GRANT UPDATE (status, error_code, finished_at) ON runs TO vasal_app;

GRANT SELECT ON inflight TO vasal_app;
GRANT UPDATE (n) ON inflight TO vasal_app;

-- Brief claims are append only too: a claim cannot be undone to spend again.
GRANT SELECT, INSERT ON run_brief_claims TO vasal_app;
