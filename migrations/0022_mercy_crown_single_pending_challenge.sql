-- A champion can defend the title against only one challenger at a time.
-- Keep the rule in D1 so parallel API requests cannot schedule competing title defenses.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mercy_crown_one_scheduled_challenge
ON mercy_crown_challenges(reign_id)
WHERE status='scheduled';
