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

-- Run tables. None holds a visitor address or its hash: the only link between
-- a visitor and a run is the unguessable run id they were handed (C6.8, C6.1).
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued', 'awaiting_confirm', 'running', 'done', 'failed')),
  input json NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  finished_at timestamptz
);

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

-- One row per brief a run has been asked to write. The claim is taken before
-- the model is called and holds no brief text, so two requests at once spend
-- once and a run's briefs stay capped (C5.8). A failed brief may be claimed
-- once more; the attempts check makes a third model call unstorable.
CREATE TABLE IF NOT EXISTS run_brief_claims (
  run_id uuid NOT NULL REFERENCES runs (id),
  guest_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'failed', 'done')),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 2),
  error_code text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, guest_id)
);

-- The finished runs the home page shows, in order. Only the operator writes
-- here, through the promote command after reading the run's board. The app
-- role can only read it (C6.3, C6.6). Twelve places cap what the page reads.
CREATE TABLE IF NOT EXISTS showcase_runs (
  run_id uuid PRIMARY KEY REFERENCES runs (id),
  position integer NOT NULL UNIQUE CHECK (position BETWEEN 1 AND 12),
  promoted_at timestamptz NOT NULL
);
