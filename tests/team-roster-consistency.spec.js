const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('team capacity and captain transfer count only players whose current team_id matches the roster row', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/team-members.js'), 'utf8');
  expect(api).toContain('p.team_id=r.team_id');
  expect(api).toContain('p.team_id=tr.team_id');
  expect(api).toContain('roster_player.team_id=tr.team_id');
  expect(api).toContain("p.profile_status='approved' AND p.archived_at IS NULL AND (p.team_id=?");
});
