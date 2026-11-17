-- MERCY MATCH chat: persistent, private match-room messages.
CREATE TABLE IF NOT EXISTS match_chat_messages (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_match_chat_messages_match_created
  ON match_chat_messages(match_id, created_at, id);
