PRAGMA foreign_keys = OFF;

CREATE TABLE team_invites_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  responded_at TEXT,
  UNIQUE (team_id, player_id)
);

INSERT INTO team_invites_new (id,team_id,player_id,invited_by,status,created_at,responded_at)
SELECT id,CAST(team_id AS TEXT),CAST(player_id AS TEXT),CAST(invited_by AS TEXT),status,created_at,responded_at
FROM team_invites;

DROP TABLE team_invites;
ALTER TABLE team_invites_new RENAME TO team_invites;

CREATE INDEX IF NOT EXISTS idx_team_invites_player_status ON team_invites(player_id,status);
CREATE INDEX IF NOT EXISTS idx_team_invites_team_status ON team_invites(team_id,status);

CREATE TABLE match_progression_new (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  next_match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  next_slot TEXT NOT NULL CHECK (next_slot IN ('team_a_id','team_b_id'))
);

INSERT INTO match_progression_new (match_id,next_match_id,next_slot)
SELECT CAST(match_id AS TEXT),CAST(next_match_id AS TEXT),next_slot FROM match_progression;

DROP TABLE match_progression;
ALTER TABLE match_progression_new RENAME TO match_progression;
CREATE INDEX IF NOT EXISTS idx_match_progression_next ON match_progression(next_match_id);

PRAGMA foreign_keys = ON;
