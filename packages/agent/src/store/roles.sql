-- The app role and its grants. Run by the operator as the owner role
-- (vasal_owner, made once by `ops bootstrap`) after migrate has created the
-- tables, so the owner owns every table granted on here. It is safe to run
-- again: the role is created only if it is missing, and the grants end the
-- same way each time. `ops roles --apply` sends the whole file as one batch.
--
-- Create this role here in SQL, not in a hosting console. Some providers put
-- console-made roles in an admin group that can create roles, databases and
-- more. A role made in SQL holds only what is granted below.
--
-- No password lives in this file. `ops roles --apply` then sets one from
-- VASAL_APP_PASSWORD as a SCRAM verifier built on the operator's machine, so
-- the password itself never reaches the server. Give the web and agent
-- servers the vasal_app connection string, never the owner's.
--
-- What the app role cannot do, by design (C6.6): change the schema, write the
-- kill switch or the showcase, change an agent key, or delete rows. Pruning
-- expired rows, setting caps or flags, revoking agent keys and promoting runs
-- are operator jobs run as the owner. Postgres 15 and later give PUBLIC no
-- CREATE on schema public, so this role cannot add tables either; on an older
-- server, revoke that first.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vasal_app') THEN
    CREATE ROLE vasal_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

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

-- Every Qloo reply's monthly count is stored by the process that got it, so
-- the app adds the one row and moves it. It cannot delete the row, and the
-- id check keeps it to one row.
GRANT SELECT, INSERT, UPDATE ON qloo_quota TO vasal_app;

GRANT SELECT ON app_flags TO vasal_app;

-- Runs are append only for the app: it can read and add rows, and on runs it
-- can move only the status fields. There is no DELETE grant on any run table.
GRANT SELECT, INSERT ON runs, run_events, run_candidates, run_board, run_briefs TO vasal_app;
GRANT UPDATE (status, error_code, finished_at) ON runs TO vasal_app;

GRANT SELECT ON inflight TO vasal_app;
GRANT UPDATE (n) ON inflight TO vasal_app;

-- Brief claims cannot be deleted, so a claim cannot be undone to spend again.
-- The app may move a claim's status, code and attempts, and its created_at,
-- which a retry resets so the stale sweep times the retry from its own claim.
-- It can never move a claim to another run or guest. The table's check stops
-- attempts at 2; that attempts never go back down is held only by the app's
-- own UPDATE, which raises it from 1 to 2 and nothing else.
GRANT SELECT, INSERT ON run_brief_claims TO vasal_app;
GRANT UPDATE (status, attempts, error_code, created_at) ON run_brief_claims TO vasal_app;

-- The home page reads the showcase. Only the operator's promote command, run
-- as the owner, can put a run on it or take one off (C6.3).
GRANT SELECT ON showcase_runs TO vasal_app;

-- Agent keys. The app may issue a key and read keys, and nothing more: with no
-- UPDATE or DELETE it cannot revoke, un-revoke or extend one. Revoking is an
-- owner job through the ops script (D1.6).
GRANT SELECT, INSERT ON mcp_tokens TO vasal_app;

-- Per-key and per-visitor counters. The app adds rows and moves only the
-- counts, never the key, the visitor or the day a row belongs to.
GRANT SELECT, INSERT ON mcp_token_daily, mcp_token_inflight, mcp_key_issue TO vasal_app;
GRANT UPDATE (runs, finds, briefs) ON mcp_token_daily TO vasal_app;
GRANT UPDATE (n) ON mcp_token_inflight TO vasal_app;
GRANT UPDATE (n) ON mcp_key_issue TO vasal_app;
