const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('tournament applications only accept approved players whose team_roster and players.team_id agree', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/applications.js'), 'utf8');
  expect(api).toContain('JOIN players p ON p.id=tr.player_id AND p.team_id=tr.team_id');
  expect(api).toContain('roster_player.team_id=tr.team_id');
  expect(api).toContain("roster_player.profile_status='approved' AND roster_player.archived_at IS NULL");
});
