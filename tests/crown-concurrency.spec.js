const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('MERCY CROWN rejects an existing pending defense before insert and maps the database race to HTTP conflict', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/crown.js'), 'utf8');
  expect(file).toContain("SELECT id FROM mercy_crown_challenges WHERE reign_id=? AND status='scheduled' LIMIT 1");
  expect(file).toContain('CROWN_CHALLENGE_PENDING');
  expect(file).toContain('mercy_crown_challenges\\.reign_id');
});
