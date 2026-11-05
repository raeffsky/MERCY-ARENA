PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS match_progression (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  next_match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  next_slot TEXT NOT NULL CHECK (next_slot IN ('team_a_id','team_b_id'))
);

CREATE INDEX IF NOT EXISTS idx_match_progression_next ON match_progression(next_match_id);
