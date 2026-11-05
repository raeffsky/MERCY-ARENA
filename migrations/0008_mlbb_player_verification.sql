ALTER TABLE players ADD COLUMN server_id TEXT;
ALTER TABLE players ADD COLUMN mlbb_verified_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_game_server_unique ON players(game_id, server_id) WHERE game_id IS NOT NULL AND server_id IS NOT NULL;
