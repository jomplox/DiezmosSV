CREATE TABLE IF NOT EXISTS login_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_rate_limits_expires_at
  ON login_rate_limits(expires_at);

CREATE INDEX IF NOT EXISTS idx_sessions_user_created_at
  ON sessions(user_id, created_at, id);
