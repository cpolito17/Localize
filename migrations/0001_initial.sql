CREATE TABLE IF NOT EXISTS location_counts_v2 (
  normalized_name TEXT NOT NULL,
  geo_bucket TEXT NOT NULL,
  location_count INTEGER NOT NULL CHECK (location_count >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (normalized_name, geo_bucket)
);

CREATE TABLE IF NOT EXISTS usage_limits (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (scope, subject, window_start)
);

CREATE INDEX IF NOT EXISTS usage_limits_window_idx ON usage_limits(window_start);
