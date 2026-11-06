PRAGMA foreign_keys = ON;

-- MERCY CIRCUIT: season-scoped team placement scoring and qualification.
-- Production D1 currently uses legacy INTEGER identifiers for core entities.
-- Keep these FK affinities aligned with the provisioned database.

CREATE TABLE IF NOT EXISTS circuit_scoring_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  place_from INTEGER NOT NULL CHECK (place_from > 0),
  place_to INTEGER NOT NULL CHECK (place_to >= place_from),
  points INTEGER NOT NULL CHECK (points >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (season_id, place_from),
  UNIQUE (season_id, place_to)
);

-- Seed the default placement ladder for every existing season.
INSERT OR IGNORE INTO circuit_scoring_rules (season_id,place_from,place_to,points)
SELECT id,1,1,100 FROM seasons;
INSERT OR IGNORE INTO circuit_scoring_rules (season_id,place_from,place_to,points)
SELECT id,2,2,75 FROM seasons;
INSERT OR IGNORE INTO circuit_scoring_rules (season_id,place_from,place_to,points)
SELECT id,3,4,55 FROM seasons;
INSERT OR IGNORE INTO circuit_scoring_rules (season_id,place_from,place_to,points)
SELECT id,5,8,25 FROM seasons;
INSERT OR IGNORE INTO circuit_scoring_rules (season_id,place_from,place_to,points)
SELECT id,9,16,10 FROM seasons;
INSERT OR IGNORE INTO circuit_scoring_rules (season_id,place_from,place_to,points)
SELECT id,17,2147483647,5 FROM seasons;

CREATE TABLE IF NOT EXISTS circuit_tournament_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  placement INTEGER NOT NULL CHECK (placement > 0),
  placement_group TEXT NOT NULL,
  points_awarded INTEGER NOT NULL CHECK (points_awarded >= 0),
  finalized_at TEXT NOT NULL,
  finalized_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tournament_id, team_id)
);

CREATE TABLE IF NOT EXISTS circuit_point_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  result_id INTEGER REFERENCES circuit_tournament_results(id) ON DELETE RESTRICT,
  points_delta INTEGER NOT NULL CHECK (points_delta != 0),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('placement_award','correction','reversal')),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_circuit_award_once
ON circuit_point_transactions(result_id, transaction_type)
WHERE transaction_type = 'placement_award';

CREATE INDEX IF NOT EXISTS idx_circuit_points_season_team
ON circuit_point_transactions(season_id, team_id);

CREATE TABLE IF NOT EXISTS circuit_qualifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  qualifier_number INTEGER NOT NULL CHECK (qualifier_number IN (1,2)),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','open','completed','cancelled')),
  awards_points INTEGER NOT NULL DEFAULT 0 CHECK (awards_points IN (0,1)),
  winner_team_id INTEGER REFERENCES teams(id),
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (season_id, qualifier_number),
  UNIQUE (tournament_id)
);

CREATE TABLE IF NOT EXISTS circuit_championship_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  qualification_source TEXT NOT NULL CHECK (qualification_source IN ('ranking','qualifier')),
  source_id INTEGER NOT NULL,
  seed INTEGER NOT NULL CHECK (seed BETWEEN 1 AND 8),
  status TEXT NOT NULL DEFAULT 'qualified' CHECK (status IN ('qualified','confirmed','withdrawn','disqualified')),
  qualified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (season_id, team_id),
  UNIQUE (season_id, seed)
);

CREATE INDEX IF NOT EXISTS idx_circuit_results_season
ON circuit_tournament_results(season_id, placement);

CREATE INDEX IF NOT EXISTS idx_circuit_qualifiers_season
ON circuit_qualifiers(season_id, qualifier_number);

CREATE INDEX IF NOT EXISTS idx_circuit_championship_season
ON circuit_championship_entries(season_id, seed);
