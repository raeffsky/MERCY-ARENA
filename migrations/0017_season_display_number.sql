PRAGMA foreign_keys = ON;

ALTER TABLE seasons ADD COLUMN season_number INTEGER;

-- Give existing seasons a stable display number based on their start date.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY starts_at ASC, id ASC) AS display_number
  FROM seasons
)
UPDATE seasons
SET season_number = (SELECT display_number FROM numbered WHERE numbered.id = seasons.id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_seasons_season_number
ON seasons(season_number)
WHERE season_number IS NOT NULL;
