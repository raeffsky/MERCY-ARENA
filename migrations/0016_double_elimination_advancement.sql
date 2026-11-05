PRAGMA foreign_keys = ON;

-- Double Elimination needs two independent outgoing paths per match:
-- the winner advances in the upper/lower bracket and the loser drops to lower.
CREATE TABLE IF NOT EXISTS match_advancement (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('winner','loser')),
  next_match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  next_slot TEXT NOT NULL CHECK (next_slot IN ('team_a_id','team_b_id')),
  PRIMARY KEY (match_id, outcome)
);

CREATE INDEX IF NOT EXISTS idx_match_advancement_next ON match_advancement(next_match_id);
