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
