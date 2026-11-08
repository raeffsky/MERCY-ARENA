PRAGMA foreign_keys = ON;

-- MERCY CROWN: immutable reign history and auditable challenger queue.
CREATE TABLE IF NOT EXISTS mercy_crown_reigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  source_match_id INTEGER REFERENCES matches(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  defenses_count INTEGER NOT NULL DEFAULT 0 CHECK (defenses_count >= 0),
  end_reason TEXT,
  awarded_by INTEGER REFERENCES users(id),
  notes TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mercy_crown_one_active_reign
  ON mercy_crown_reigns(1) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mercy_crown_reigns_team ON mercy_crown_reigns(team_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mercy_crown_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenger_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','scheduled','completed','declined','cancelled')),
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  result_match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mercy_crown_one_open_challenge ON mercy_crown_challenges(challenger_team_id) WHERE status IN ('pending','accepted','scheduled');
CREATE INDEX IF NOT EXISTS idx_mercy_crown_challenges_status ON mercy_crown_challenges(status, created_at DESC);

CREATE TABLE IF NOT EXISTS mercy_scout_watchlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, player_id)
);
