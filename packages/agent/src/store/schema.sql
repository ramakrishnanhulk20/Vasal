-- migrate.ts may run this file any number of times, so every statement must be
-- safe to rerun. It needs the database owner: the app role cannot create tables.

CREATE TABLE IF NOT EXISTS usage_buckets (
  key text PRIMARY KEY,
  cap bigint NOT NULL CHECK (cap >= 0),
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  window_end timestamptz NOT NULL
);

-- json, not jsonb: jsonb reorders object keys and drops duplicate keys, so a
-- body read back would no longer be the text that passed the schema.
CREATE TABLE IF NOT EXISTS qloo_cache (
  cache_key text PRIMARY KEY,
  body json NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- One row: Qloo's own monthly count from the newest reply recorded here. It
-- counts every call made with the key, including ones this meter never saw,
-- such as a local script's, so the meter can stop under a floor.
CREATE TABLE IF NOT EXISTS qloo_quota (
  id smallint PRIMARY KEY CHECK (id = 1),
  remaining integer NOT NULL,
  quota_limit integer NOT NULL,
  seen_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_flags (
  name text PRIMARY KEY,
  value boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS visitor_counters (
  visitor_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_hash, window_start)
);

-- Agent keys for the MCP door. Only the SHA-256 of a key is kept, so reading
-- this table yields nothing that works as a key (D1.1). No column links a key
-- to a visitor, raw or hashed (D1.7). It comes before runs, which point here.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS mcp_token_daily (
  token_id uuid NOT NULL REFERENCES mcp_tokens (id) ON DELETE CASCADE,
  day date NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  finds integer NOT NULL DEFAULT 0,
  briefs integer NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, day)
);

CREATE TABLE IF NOT EXISTS mcp_token_inflight (
  token_id uuid PRIMARY KEY REFERENCES mcp_tokens (id) ON DELETE CASCADE,
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0)
);

-- Keys issued per visitor per UTC day. The visitor is the keyed hash from
-- visitorKey, and nothing here says which key went to whom (D1.7, C6.8).
CREATE TABLE IF NOT EXISTS mcp_key_issue (
  visitor_hash text NOT NULL,
  day date NOT NULL,
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_hash, day)
);

-- Run tables. None holds a visitor address or its hash: the only link between
-- a visitor and a run is the unguessable run id they were handed (C6.8, C6.1).
-- surface records, at creation, which share a run spends from, and an MCP run
-- records the id of the key row that started it, never the key (D3.2, D4.1).
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued', 'awaiting_confirm', 'running', 'done', 'failed')),
  input json NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  surface text NOT NULL DEFAULT 'web' CHECK (surface IN ('web', 'mcp')),
  token_id uuid REFERENCES mcp_tokens (id),
  CHECK ((surface = 'web' AND token_id IS NULL) OR (surface = 'mcp' AND token_id IS NOT NULL))
);

-- The prune keeps every key a run still points to, and this makes that check
-- an index lookup.
CREATE INDEX IF NOT EXISTS runs_token_id ON runs (token_id) WHERE token_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_events (
  run_id uuid NOT NULL REFERENCES runs (id),
  seq integer NOT NULL CHECK (seq >= 1),
  event text NOT NULL,
  data json NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS run_candidates (
  run_id uuid NOT NULL REFERENCES runs (id),
  candidate_id uuid NOT NULL,
  rank integer NOT NULL,
  data json NOT NULL,
  PRIMARY KEY (run_id, candidate_id)
);

-- An MCP caller names a candidate by its id alone, with no run id, so that
-- lookup needs its own index.
CREATE INDEX IF NOT EXISTS run_candidates_candidate_id ON run_candidates (candidate_id);

CREATE TABLE IF NOT EXISTS run_board (
  run_id uuid NOT NULL REFERENCES runs (id),
  guest_id uuid NOT NULL,
  rank integer NOT NULL,
  data json NOT NULL,
  PRIMARY KEY (run_id, guest_id)
);

CREATE TABLE IF NOT EXISTS run_briefs (
  run_id uuid NOT NULL REFERENCES runs (id),
  guest_id uuid NOT NULL,
  data json NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, guest_id)
);

-- One row per global counter. The app role can only move n, never add rows,
-- so the row is created here.
CREATE TABLE IF NOT EXISTS inflight (
  slot text PRIMARY KEY,
  n integer NOT NULL CHECK (n >= 0)
);

INSERT INTO inflight (slot, n) VALUES ('runs', 0) ON CONFLICT DO NOTHING;

-- MCP runs take this slot and a 'runs' slot together, so MCP never holds more
-- of the site's places than this slot allows (D3.3).
INSERT INTO inflight (slot, n) VALUES ('mcp', 0) ON CONFLICT DO NOTHING;

-- One row per brief a run has been asked to write. The claim is taken before
-- the model is called and holds no brief text, so two requests at once spend
-- once and a run's briefs stay capped (C5.8). A failed brief may be claimed
-- once more; the attempts check makes a third model call unstorable. A claim
-- a budget refused is deferred: it spent no attempt and may be claimed again.
CREATE TABLE IF NOT EXISTS run_brief_claims (
  run_id uuid NOT NULL REFERENCES runs (id),
  guest_id uuid NOT NULL,
  status text NOT NULL CONSTRAINT run_brief_claims_status_check CHECK (status IN ('pending', 'failed', 'done', 'deferred')),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 2),
  error_code text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, guest_id)
);

-- CREATE TABLE IF NOT EXISTS leaves an existing table's checks as they were,
-- so the status check is dropped and added again on every migrate. A table
-- made before 'deferred' had the same name for it, the one Postgres gives an
-- unnamed column check.
ALTER TABLE run_brief_claims DROP CONSTRAINT IF EXISTS run_brief_claims_status_check;
ALTER TABLE run_brief_claims ADD CONSTRAINT run_brief_claims_status_check
  CHECK (status IN ('pending', 'failed', 'done', 'deferred'));

-- The finished runs the home page shows, in order. Only the operator writes
-- here, through the promote command after reading the run's board. The app
-- role can only read it (C6.3, C6.6). Twelve places cap what the page reads.
CREATE TABLE IF NOT EXISTS showcase_runs (
  run_id uuid PRIMARY KEY REFERENCES runs (id),
  position integer NOT NULL UNIQUE CHECK (position BETWEEN 1 AND 12),
  promoted_at timestamptz NOT NULL
);

-- Once a run is on the showcase, the app role cannot add, change or delete
-- any of its rows, whatever its grants say or its code does (C6.6). The
-- check is on the role's name, so the owner can still correct or prune a
-- promoted run. An update is checked against the row's run before and after,
-- so a row can be moved neither off a promoted run nor onto one. The
-- showcase is named with its schema, and temporary tables are searched last,
-- so a temporary table called showcase_runs cannot stand in for it. Row
-- triggers do not fire on TRUNCATE, which the app role holds no grant for.
CREATE OR REPLACE FUNCTION refuse_promoted_write() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old_run uuid;
  new_run uuid;
BEGIN
  IF current_user = 'vasal_app' THEN
    IF TG_TABLE_NAME = 'runs' THEN
      IF TG_OP <> 'INSERT' THEN
        old_run := OLD.id;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        new_run := NEW.id;
      END IF;
    ELSE
      IF TG_OP <> 'INSERT' THEN
        old_run := OLD.run_id;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        new_run := NEW.run_id;
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.showcase_runs WHERE run_id = old_run OR run_id = new_run) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A run on the showcase is read-only to the app role.';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS refuse_promoted_write ON runs;
CREATE TRIGGER refuse_promoted_write BEFORE INSERT OR UPDATE OR DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION refuse_promoted_write();

DROP TRIGGER IF EXISTS refuse_promoted_write ON run_events;
CREATE TRIGGER refuse_promoted_write BEFORE INSERT OR UPDATE OR DELETE ON run_events
  FOR EACH ROW EXECUTE FUNCTION refuse_promoted_write();

DROP TRIGGER IF EXISTS refuse_promoted_write ON run_candidates;
CREATE TRIGGER refuse_promoted_write BEFORE INSERT OR UPDATE OR DELETE ON run_candidates
  FOR EACH ROW EXECUTE FUNCTION refuse_promoted_write();

DROP TRIGGER IF EXISTS refuse_promoted_write ON run_board;
CREATE TRIGGER refuse_promoted_write BEFORE INSERT OR UPDATE OR DELETE ON run_board
  FOR EACH ROW EXECUTE FUNCTION refuse_promoted_write();

DROP TRIGGER IF EXISTS refuse_promoted_write ON run_briefs;
CREATE TRIGGER refuse_promoted_write BEFORE INSERT OR UPDATE OR DELETE ON run_briefs
  FOR EACH ROW EXECUTE FUNCTION refuse_promoted_write();

DROP TRIGGER IF EXISTS refuse_promoted_write ON run_brief_claims;
CREATE TRIGGER refuse_promoted_write BEFORE INSERT OR UPDATE OR DELETE ON run_brief_claims
  FOR EACH ROW EXECUTE FUNCTION refuse_promoted_write();
