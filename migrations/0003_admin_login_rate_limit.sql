CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_email_time ON auth_login_attempts(email_hash, attempted_at);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_ip_time ON auth_login_attempts(ip_hash, attempted_at);
