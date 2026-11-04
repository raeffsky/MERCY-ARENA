PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('player','team_captain','organizer','referee','administrator')),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','upcoming','active','completed','archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  game TEXT NOT NULL DEFAULT 'Mobile Legends: Bang Bang',
  region TEXT,
  format TEXT NOT NULL CHECK (format IN ('single_elimination','double_elimination','round_robin','swiss','group_playoff')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','registration_open','registration_closed','ongoing','completed','cancelled')),
  max_teams INTEGER CHECK (max_teams IS NULL OR max_teams > 1),
  registration_open_at TEXT,
  registration_close_at TEXT,
  starts_at TEXT,
  ends_at TEXT,
  rules_url TEXT,
  season_id TEXT REFERENCES seasons(id),
  organizer_id TEXT NOT NULL REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  captain_id TEXT REFERENCES users(id),
  region TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','disbanded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  game_id TEXT UNIQUE,
  nickname TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('EXP','JUNGLE','MID','GOLD','ROAM','FLEX')),
  team_id TEXT REFERENCES teams(id),
  region TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS team_roster (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  roster_role TEXT NOT NULL DEFAULT 'player' CHECK (roster_role IN ('captain','player','substitute')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at TEXT,
  PRIMARY KEY (team_id, player_id)
);

CREATE TABLE IF NOT EXISTS tournament_registrations (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT,
  reviewer_id TEXT REFERENCES users(id),
  UNIQUE (tournament_id, team_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  bracket TEXT NOT NULL DEFAULT 'main' CHECK (bracket IN ('main','upper','lower','group','final')),
  match_number INTEGER NOT NULL CHECK (match_number > 0),
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scheduled','live','awaiting_review','confirmed','disputed','cancelled')),
  team_a_id TEXT REFERENCES teams(id),
  team_b_id TEXT REFERENCES teams(id),
  score_a INTEGER CHECK (score_a IS NULL OR score_a >= 0),
  score_b INTEGER CHECK (score_b IS NULL OR score_b >= 0),
  winner_team_id TEXT REFERENCES teams(id),
  result_source TEXT,
  result_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tournament_id, bracket, round_number, match_number)
);

CREATE TABLE IF NOT EXISTS result_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches(id),
  payload_hash TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('received','validated','rejected','needs_review','confirmed')),
  reviewer_id TEXT REFERENCES users(id),
  decision_reason TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT,
  UNIQUE (provider, provider_event_id),
  UNIQUE (provider, payload_hash)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_tournaments_public ON tournaments(status, published_at DESC, starts_at);
CREATE INDEX IF NOT EXISTS idx_teams_name ON teams(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_players_nickname ON players(nickname COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_matches_schedule ON matches(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id, round_number, match_number);
CREATE INDEX IF NOT EXISTS idx_registrations_tournament ON tournament_registrations(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at DESC);
