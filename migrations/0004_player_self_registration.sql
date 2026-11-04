ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE players ADD COLUMN profile_status TEXT NOT NULL DEFAULT 'approved' CHECK (profile_status IN ('pending','approved','rejected'));
CREATE INDEX IF NOT EXISTS idx_players_profile_status ON players(profile_status);
