const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test('MERCY MATCH room access is limited to authenticated match participants and staff', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('getSessionUser(request, env)');
  expect(api).toContain('if (!access.canManage && !access.participant && !access.observer)');
  expect(api).toContain('MATCH_ACCESS_DENIED');
  expect(api).toContain('const judge = staff?.staff_role === "referee"');
  expect(api).toContain('const staff = await db.prepare("SELECT staff_role FROM tournament_staff');
  expect(api).toContain('String(match.organizer_id) === String(user.id)');
  expect(api).toContain("JOIN teams t ON t.id=p.team_id AND t.status='active' AND t.archived_at IS NULL");
});

test('room credentials are hidden from participants until published and hidden after the match ends', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('const tournamentActive = !!match.tournament_published_at && ["published", "active"].includes(match.tournament_status)');
  expect(api).toContain('const matchActive = tournamentActive && ["scheduled", "in_progress"].includes(match.status)');
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

test('assigned observers can read a match room without receiving management or readiness permissions', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('const observer = staff?.staff_role === "observer"');
  expect(api).toContain('const judge = staff?.staff_role === "referee"');
  expect(api).toContain('canReady: captainA || captainB');
  expect(api).toContain('!access.observer');
  expect(api).toContain('canManage: owner || organizer || judge');
});

test('assigned referees can verify a match result and advance the tournament bracket', () => {
  const api = source('functions/api/v1/match-room.js');
  const page = source('match.html');
  expect(api).toContain('action === "verify_result"');
  expect(api).toContain("result_source='judge_verified'");
  expect(api).toContain('advanceWinner(db,id,winner)');
  expect(api).toContain('judge_match_result_verified');
  expect(api).toContain('can_verify_result: (access.owner || access.organizer || access.judge) && tournamentActive && (matchActive || (match.status === "completed" && !!match.result_verified_at))');
  expect(api).toContain('progression_retried: true');
  expect(page).toContain('ПОВТОРИТЬ ПРОДВИЖЕНИЕ ПО СЕТКЕ');
  expect(page).toContain('id="judgePanel"');
  expect(page).toContain("action:'verify_result'");
});

test('referee result entry enforces the BO1, BO3 and BO5 map-win thresholds', () => {
  const api = source('functions/api/v1/match-room.js');
  const organizer = source('functions/api/v1/organizer.js');
  const page = source('match.html');
  expect(api).toContain('BO1: 1, BO3: 2, BO5: 3');
  expect(api).toContain('SERIES_NOT_FINISHED');
  expect(organizer).toContain('BO1:1,BO3:2,BO5:3');
  expect(page).toContain('ПОБЕДЫ НА КАРТАХ A');
  expect(page).toContain('ПОБЕДЫ НА КАРТАХ B');
});
