-- MERCY MATCH: private operational room for real MLBB custom-room matches.
CREATE TABLE IF NOT EXISTS match_rooms (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  series_format TEXT NOT NULL DEFAULT 'BO1' CHECK (series_format IN ('BO1','BO3','BO5')),
  room_id TEXT,
  room_password TEXT,
  room_published_at TEXT,
  judge_contact TEXT,
  instructions TEXT,
  team_a_ready_at TEXT,
  team_b_ready_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_match_rooms_updated ON match_rooms(updated_at);
