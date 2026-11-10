-- Referee-submitted match results require confirmation by the opposing team's captain.
CREATE TABLE IF NOT EXISTS match_result_submissions (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  proposed_by TEXT NOT NULL REFERENCES users(id),
  score_a INTEGER NOT NULL CHECK (score_a >= 0),
  score_b INTEGER NOT NULL CHECK (score_b >= 0),
  winner_team_id TEXT NOT NULL REFERENCES teams(id),
  confirming_team_id TEXT NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','disputed')),
  submitted_at TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  dispute_reason TEXT CHECK (dispute_reason IS NULL OR length(dispute_reason) <= 500),
  CHECK (score_a <> score_b)
);
CREATE INDEX IF NOT EXISTS idx_match_result_submissions_status
  ON match_result_submissions(status, submitted_at);
