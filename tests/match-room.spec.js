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

test('readiness identity requires an approved player profile with active team roster membership', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain("AND EXISTS (SELECT 1 FROM team_roster tr WHERE tr.player_id=p.id AND tr.team_id=t.id AND tr.left_at IS NULL)");
  expect(api).toContain("SELECT team_id FROM team_roster WHERE player_id=? AND left_at IS NULL AND team_id IN (?,?) AND team_id=?");
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
  expect(api).toContain('advanceWinner(db,id,submission.winner_team_id)');
  expect(api).toContain('judge_match_result_submitted');
  expect(api).toContain('can_verify_result: (access.owner || access.organizer || access.judge) && tournamentActive && matchActive');
  expect(api).toContain('action === "confirm_result" || action === "dispute_result"');
  expect(page).toContain('ОТПРАВИТЬ НА ПОДТВЕРЖДЕНИЕ');
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

test('changing room ID, password or BO format clears stale team readiness', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('const readinessReset = !!previousRoom');
  expect(api).toContain('team_a_ready_at=CASE WHEN match_rooms.series_format<>excluded.series_format');
  expect(api).toContain('team_b_ready_at=CASE WHEN match_rooms.series_format<>excluded.series_format');
  expect(api).toContain('readiness_reset: readinessReset');
});

test('resetting both teams readiness uses one atomic D1 batch', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('const resetWrites = []');
  expect(api).toContain('if (resetWrites.length) await db.batch(resetWrites)');
});

test('MERCY MATCH page offers sign-in when a visitor opens a private room', () => {
  const page = source('match.html');
  expect(page).toContain('id="loginLink"');
  expect(page).toContain('error.status=r.status');
  expect(page).toContain("$('loginLink').hidden=e.status!==401");
});

test('captains cannot confirm match readiness before completing mandatory tournament check-in', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('t.checkin_required');
  expect(api).toContain('if (match.checkin_required)');
  expect(api).toContain('TEAM_NOT_CHECKED_IN');
  expect(api).toContain("[\"checked_in\",\"excused\"].includes(checkin.status)");
});

test('referees can award a forfeit only after an approved team is confirmed as a no-show', () => {
  const api = source('functions/api/v1/match-room.js');
  const page = source('match.html');
  expect(api).toContain('action === "forfeit_no_show"');
  expect(api).toContain('NO_SHOW_NOT_CONFIRMED');
  expect(api).toContain('OPPONENT_NOT_CHECKED_IN');
  expect(api).toContain("r.status='approved'");
  expect(api).toContain("result_source='no_show_forfeit'");
  expect(api).toContain('judge_match_forfeit');
  expect(page).toContain('data-checkin-forfeit');
  expect(page).toContain('ПРИСУДИТЬ ТЕХНИЧЕСКОЕ ПОРАЖЕНИЕ');
});

test('judge results remain pending until the opposing captain confirms them', () => {
  const api = source('functions/api/v1/match-room.js');
  const migration = source('migrations/0025_match_result_confirmation.sql');
  const page = source('match.html');
  expect(api).toContain('action === "verify_result"');
  expect(api).toContain('INSERT INTO match_result_submissions');
  expect(api).toContain('action === "confirm_result" || action === "dispute_result"');
  expect(api).toContain('OPPONENT_CONFIRMATION_REQUIRED');
  expect(api).toContain('OPPONENT_CAPTAIN_REQUIRED');
  expect(api).toContain('SUBMITTER_CANNOT_CONFIRM');
  expect(api).toContain('String(access.userId) !== String(submission.proposed_by)');
  expect(api).toContain('action === "resolve_result"');
  expect(api).toContain('["pending","disputed"].includes(submission.status)');
  expect(api).toContain('RESOLUTION_REASON_REQUIRED');
  expect(api).toContain('advanceWinner(db,id,submission.winner_team_id)');
  expect(migration).toContain("status IN ('pending','confirmed','disputed')");
  expect(migration).toContain('confirming_team_id TEXT NOT NULL');
  expect(page).toContain('id="resultReviewPanel"');
  expect(page).toContain("action:'confirm_result'");
  expect(page).toContain("action:'dispute_result'");
  expect(page).toContain("action:'resolve_result'");
  expect(page).toContain('id="resolveReason"');
});

test('result confirmation and match completion are committed in one conditional D1 batch', () => {
  const api = source('functions/api/v1/match-room.js');
  expect(api).toContain('const decisionResults = await db.batch(decisionWrites)');
  expect(api).toContain('decisionResults[1]?.meta?.changes');
  expect(api).toContain('const writes = await db.batch([');
  expect(api).toContain('RESULT_DECISION_CONFLICT');
});

test('organizer cabinet cannot bypass referee and opponent result confirmation', () => {
  const organizer = source('functions/api/v1/organizer.js');
  const page = source('index.html');
  expect(organizer).toContain('MATCH_ROOM_REQUIRED');
  expect(organizer).not.toContain("result_source='organizer_manual'");
  expect(organizer).toContain('LEFT JOIN match_result_submissions rs ON rs.match_id=m.id');
  expect(page).not.toContain('org-match-result');
  expect(page).toContain('/match.html?id=');
});

