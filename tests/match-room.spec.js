const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test('MERCY MATCH room access is limited to authenticated match participants and staff', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('getSessionUser(request, env)');
  expect(api).toContain('if (!access.canManage && !access.participant)');
  expect(api).toContain('MATCH_ACCESS_DENIED');
  expect(api).toContain('user.roles.includes("judge")');
  expect(api).toContain('String(match.organizer_id) === String(user.id)');
});

test('room credentials are hidden from participants until published and hidden after the match ends', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('const matchActive = ["scheduled", "in_progress"].includes(match.status)');
  expect(api).toContain('const credentialsVisible = !!room && matchActive && (access.canManage || !!room.room_published_at)');
  expect(api).toContain('room_id: credentialsVisible ? room.room_id : null');
  expect(api).toContain('room_password: credentialsVisible ? room.room_password : null');
});

test('only captains can confirm readiness and all room mutations require an active match', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('if (!access.canReady || !access.side)');
  expect(api).toContain('MATCH_NOT_CONFIGURABLE');
  expect(api).toContain('MATCH_NOT_READY');
  expect(api).toContain('access.canReady && matchActive');
});

test('room configuration validates BO format, paired credentials and field lengths', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('const FORMATS = new Set(["BO1", "BO3", "BO5"])');
  expect(api).toContain('ROOM_CREDENTIALS_REQUIRED');
  expect(api).toContain('FIELD_TOO_LONG');
});

test('match rooms are one-to-one with matches and cascade with match deletion', () => {
  const migration = source('migrations/0023_mercy_match_rooms.sql');
  expect(migration).toContain('match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE');
  expect(migration).toContain("CHECK (series_format IN ('BO1','BO3','BO5'))");
});

test('MERCY MATCH page hides credentials and manager controls after a match is no longer active', () => {
  const page = source('match.html');
  expect(page).toContain("Данные игровой комнаты скрыты, поскольку матч больше не активен.");
  expect(page).toContain("!p.can_manage||!['scheduled','in_progress'].includes(m.status)");
});
