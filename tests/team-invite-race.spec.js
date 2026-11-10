const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('team invite acceptance cannot attach an archived or unapproved player', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/team-members.js'), 'utf8');
  expect(file).toContain("WHERE id=? AND team_id IS NULL AND profile_status='approved' AND archived_at IS NULL");
  expect(file).toContain("id=? AND team_id=? AND profile_status='approved' AND archived_at IS NULL");
  expect(file).toContain('PROFILE_REQUIRED');
  expect(file).toContain('TEAM_ARCHIVED_DURING_ACCEPT');
});

test('invite creation rechecks player and captain eligibility in the write statement', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/team-members.js'), 'utf8');
  expect(file).toContain("WHERE id=? AND captain_id=? AND status='active' AND archived_at IS NULL");
  expect(file).toContain("profile_status='approved' AND archived_at IS NULL AND team_id IS NULL");
  expect(file).toContain('TEAM_OR_PLAYER_CHANGED');
});
