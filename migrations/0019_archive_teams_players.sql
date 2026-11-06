-- Preserve tournament and match history when administrators remove teams or players.
ALTER TABLE teams ADD COLUMN archived_at TEXT;
ALTER TABLE players ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_teams_archived_at ON teams(archived_at);
CREATE INDEX IF NOT EXISTS idx_players_archived_at ON players(archived_at);
