const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('MERCY CROWN defense history links to the tournament, not the match ID', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/crown.js'), 'utf8');
  const page = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  expect(api).toContain('m.tournament_id,m.scheduled_at');
  expect(page).toContain('href="#/tournament/\'+esc(item.tournament_id)');
  expect(page).toContain("'#'+esc(item.match_id)");
});
