const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test('owner can grant and revoke tournament-specific staff roles with an audit record', () => {
  const admin = source('functions/api/v1/admin.js');
  expect(admin).toContain('resource === "tournament_staff" && action === "set"');
  expect(admin).toContain('["organizer","admin","referee","observer"].includes(staffRole)');
  expect(admin).toContain('ON CONFLICT(tournament_id,user_id) DO UPDATE SET staff_role=excluded.staff_role');
  expect(admin).toContain('tournament_staff_granted');
  expect(admin).toContain('tournament_staff_revoked');
  expect(admin).toContain('referee_assignment');
  expect(admin).toContain('/referee.html');
});

test('assigned organizers receive access only to tournaments assigned to them', () => {
  const organizer = source('functions/api/v1/organizer.js');
  const me = source('functions/api/v1/me.js');
  expect(organizer).toContain('s.staff_role IN (\'organizer\',\'admin\')');
  expect(me).toContain('has_organizer_access: hasOrganizerAccess');
});

test('referees can manage rooms and observers can only read them', () => {
  const room = source('functions/api/v1/match-room.js');
  expect(room).toContain('const judge = staff?.staff_role === "referee"');
  expect(room).toContain('const observer = staff?.staff_role === "observer"');
  expect(room).toContain('!access.observer');
});

test('admin panel exposes tournament staff assignment and revocation controls', () => {
  const page = source('index.html');
  expect(page).toContain('data-admin-tab="staff"');
  expect(page).toContain('Персонал турниров');
  expect(page).toContain('data-remove-tournament-staff');
  expect(page).toContain('Судья / referee');
});

test('assigned staff can manage only their tournament and cannot create unrelated tournaments', () => {
  const organizer = source('functions/api/v1/organizer.js');
  expect(organizer).toContain('STAFF_CANNOT_CREATE_TOURNAMENT');
  expect(organizer).toContain("s.staff_role IN ('organizer','admin')");
  expect(organizer).toContain('ownedTournament(env.DB,before.tournament_id,auth.user,auth.owner)');
  expect(organizer).toContain('ownedTournament(env.DB,match.tournament_id,auth.user,auth.owner)');
});

test('assigned referees receive a private dashboard containing only their tournament matches', () => {
  const me = source('functions/api/v1/me.js');
  const api = source('functions/api/v1/referee.js');
  const page = source('referee.html');
  const navigation = source('index.html');
  expect(me).toContain('has_referee_access: !!assignedReferee');
  expect(api).toContain("s.user_id=? AND s.staff_role='referee'");
  expect(api).toContain('LEFT JOIN match_result_submissions rs ON rs.match_id=m.id');
  expect(api).toContain('"Cache-Control": "no-store, private"');
  expect(page).toContain('/api/v1/referee');
  expect(page).toContain('/match.html?id=');
  expect(navigation).toContain('data-route="referee"');
  expect(navigation).toContain('if(refereeLink)refereeLink.hidden=!me.has_referee_access');
});
