PRAGMA foreign_keys = OFF;

CREATE TABLE auth_sessions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO auth_sessions_new (id,user_id,token_hash,expires_at,revoked_at,created_at)
SELECT id,CAST(user_id AS TEXT),token_hash,expires_at,revoked_at,created_at
FROM auth_sessions;

DROP TABLE auth_sessions;
ALTER TABLE auth_sessions_new RENAME TO auth_sessions;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

PRAGMA foreign_keys = ON;
