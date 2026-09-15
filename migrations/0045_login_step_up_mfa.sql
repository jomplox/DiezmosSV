-- A distributed password-guessing campaign must not force a blind account lockout.
-- After the account-wide failure threshold, valid credentials issue this short-lived
-- email challenge instead of a session. Raw continuation tokens and codes never land
-- in D1; the code hash is domain-separated and bound to the random continuation token.
CREATE TABLE login_step_up_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  continuation_token_hash TEXT NOT NULL UNIQUE CHECK (
    length(continuation_token_hash) = 64
    AND continuation_token_hash = lower(continuation_token_hash)
    AND continuation_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  code_hash TEXT NOT NULL CHECK (
    length(code_hash) = 64
    AND code_hash = lower(code_hash)
    AND code_hash NOT GLOB '*[^0-9a-f]*'
  ),
  expected_email TEXT NOT NULL,
  expected_auth_generation INTEGER NOT NULL CHECK (expected_auth_generation >= 0),
  expected_password_hash TEXT NOT NULL,
  expected_password_salt TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  consumed_at TEXT,
  invalidated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

CREATE INDEX idx_login_step_up_challenges_expires
  ON login_step_up_challenges(expires_at);

CREATE INDEX idx_login_step_up_challenges_user_expires
  ON login_step_up_challenges(user_id, expected_auth_generation, expires_at);
