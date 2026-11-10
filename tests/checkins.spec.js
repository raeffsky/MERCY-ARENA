const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test('tournament check-in stores auditable team attendance with one record per team', () => {
  const migration = source('migrations/0024_tournament_checkins.sql');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS tournament_checkins');
  expect(migration).toContain('UNIQUE (tournament_id, team_id)');
  expect(migration).toContain("CHECK (status IN ('pending','checked_in','no_show','excused'))");
  expect(migration).toContain('checked_in_by TEXT REFERENCES users(id)');
  expect(migration).toContain('decision_by TEXT REFERENCES users(id)');
});

test('only the captain of an approved active team can check in during the configured window', () => {
  const api = source('functions/api/v1/checkins.js');
  expect(api).toContain('CAPTAIN_REQUIRED');
  expect(api).toContain('REGISTRATION_NOT_APPROVED');
  expect(api).toContain('CHECKIN_WINDOW_CLOSED');
  expect(api).toContain('CHECKIN_DISABLED');
  expect(api).toContain('tm.captain_id=?');
  expect(api).toContain('checkinWindow(tournament)');
});

test('organizers and referees can mark no-shows, excuse teams and reset attendance with an audit event', () => {
  const api = source('functions/api/v1/checkins.js');
  expect(api).toContain('STAFF_REQUIRED');
  expect(api).toContain('action === "mark_no_show"');
  expect(api).toContain('action === "excuse"');
  expect(api).toContain('action === "reset"');
  expect(api).toContain('tournament_checkin_');
  expect(api).toContain('await env.DB.batch');
});

test('organizers can configure mandatory check-in and a custom time window', () => {
  const organizer = source('functions/api/v1/organizer.js');
  const page = source('index.html');
  const admin = source('functions/api/v1/admin.js');
  expect(organizer).toContain('checkin_required:checkinRequired');
  expect(organizer).toContain('checkin_open_at:checkinOpen,checkin_close_at:checkinClose');
  expect(page).toContain('ОБЯЗАТЕЛЬНЫЙ CHECK-IN');
  expect(admin).toContain('checkin_required');
});

test('MERCY MATCH refuses readiness until the captain has checked in when the tournament requires it', () => {
  const room = source('functions/api/v1/match-room.js');
  const page = source('match.html');
  expect(room).toContain('if (match.checkin_required)');
  expect(room).toContain('TEAM_NOT_CHECKED_IN');
  expect(page).toContain('id="checkinPanel"');
  expect(page).toContain('/api/v1/checkins?tournament_id=');
  expect(page).toContain('ПОДТВЕРДИТЬ УЧАСТИЕ');
});
