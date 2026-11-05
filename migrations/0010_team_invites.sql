PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  responded_at TEXT,
  UNIQUE (team_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_team_roster_player_active ON team_roster(player_id, left_at);
CREATE INDEX IF NOT EXISTS idx_team_invites_player_status ON team_invites(player_id, status);
CREATE INDEX IF NOT EXISTS idx_team_invites_team_status ON team_invites(team_id, status);
