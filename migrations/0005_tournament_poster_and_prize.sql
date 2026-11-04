-- Add organizer-managed tournament artwork and prize information.
ALTER TABLE tournaments ADD COLUMN poster_url TEXT;
ALTER TABLE tournaments ADD COLUMN prize_pool TEXT;
