-- Optional team check-in window and auditable attendance state.
ALTER TABLE tournaments ADD COLUMN checkin_required INTEGER NOT NULL DEFAULT 0 CHECK (checkin_required IN (0,1));
ALTER TABLE tournaments ADD COLUMN checkin_open_at TEXT;
ALTER TABLE tournaments ADD COLUMN checkin_close_at TEXT;

CREATE TABLE IF NOT EXISTS tournament_checkins (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  registration_id TEXT NOT NULL REFERENCES tournament_registrations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','checked_in','no_show','excused')),
  checked_in_by TEXT REFERENCES users(id),
  checked_in_at TEXT,
  decision_by TEXT REFERENCES users(id),
  decision_at TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tournament_id, team_id),
  UNIQUE (registration_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_checkins_status
  ON tournament_checkins(tournament_id, status, updated_at);
