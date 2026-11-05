PRAGMA foreign_keys = ON;

ALTER TABLE tournament_registrations ADD COLUMN selected_slot TEXT;
ALTER TABLE tournament_registrations ADD COLUMN captain_note TEXT;
ALTER TABLE tournament_registrations ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS tournament_registration_roster (
  registration_id INTEGER NOT NULL REFERENCES tournament_registrations(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  roster_role TEXT NOT NULL DEFAULT 'starter' CHECK (roster_role IN ('starter','substitute')),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (registration_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_registration_roster_player ON tournament_registration_roster(player_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  entity_type TEXT,
  entity_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS tournament_staff (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_role TEXT NOT NULL CHECK (staff_role IN ('organizer','admin','referee','observer')),
  granted_by INTEGER REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_staff_user ON tournament_staff(user_id);
