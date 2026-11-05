ALTER TABLE seasons ADD COLUMN season_number INTEGER;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY starts_at ASC, id ASC) AS number
  FROM seasons
)
UPDATE seasons
SET season_number = (SELECT number FROM numbered WHERE numbered.id = seasons.id)
WHERE season_number IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_seasons_season_number
ON seasons(season_number)
WHERE season_number IS NOT NULL;
