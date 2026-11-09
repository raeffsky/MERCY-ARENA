-- MERCY CROWN: persistent title reigns and verified title defenses.
CREATE TABLE IF NOT EXISTS mercy_crown_reigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  defenses_count INTEGER NOT NULL DEFAULT 0 CHECK (defenses_count >= 0),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mercy_crown_one_active_reign
ON mercy_crown_reigns((1)) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS mercy_crown_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reign_id INTEGER NOT NULL REFERENCES mercy_crown_reigns(id) ON DELETE RESTRICT,
  champion_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  challenger_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  match_id INTEGER NOT NULL UNIQUE REFERENCES matches(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','decided','cancelled')),
  winner_team_id INTEGER REFERENCES teams(id) ON DELETE RESTRICT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK (champion_team_id != challenger_team_id),
  CHECK (winner_team_id IS NULL OR winner_team_id IN (champion_team_id,challenger_team_id))
);

CREATE INDEX IF NOT EXISTS idx_mercy_crown_challenges_reign
ON mercy_crown_challenges(reign_id, created_at DESC);
