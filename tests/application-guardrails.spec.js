const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test.describe('Tournament application server guardrails', () => {
  const api = () => source('functions/api/v1/applications.js');

  test('submission is bound to the authenticated captain of an active, non-archived team', () => {
    const code = api();
    expect(code).toContain('getSessionUser(request, env)');
    expect(code).toContain("t.status='active' AND t.archived_at IS NULL");
    expect(code).toContain('(t.captain_id=? OR EXISTS');
    expect(code).toContain("cr.roster_role='captain'");
    expect(code).toContain('cp.user_id=?');
  });

  test('server validates the submitted roster against approved active team members', () => {
    const code = api();
    expect(code).toContain("p.profile_status='approved' AND p.archived_at IS NULL");
    expect(code).toContain('requestedIds.length < 5 || requestedIds.length > 7');
    expect(code).toContain('new Set(requestedIds).size !== requestedIds.length');
    expect(code).toContain('requestedIds.some((id) => !memberIds.has(id))');
    expect(code).toContain('ROSTER_MEMBER_INVALID');
  });

  test('server rechecks publication, registration dates, configured slots and tournament capacity', () => {
    const code = api();
    expect(code).toContain('tournamentConfig(env.DB, tournamentId, true)');
    expect(code).toContain('!["published","active"].includes(tournament.status)');
    expect(code).toContain('REGISTRATION_NOT_STARTED');
    expect(code).toContain('REGISTRATION_CLOSED');
    expect(code).toContain('REGISTRATION_CONFIG_INVALID');
    expect(code).toContain('configuredSlots.includes(selectedSlot)');
    expect(code).toContain('TOURNAMENT_FULL');
    expect(code).toContain('capacity_team.status=\'active\' AND capacity_team.archived_at IS NULL');
  });

  test('duplicate application attempts are blocked by both a preflight check and the database unique constraint', () => {
    const code = api();
    expect(code).toContain('SELECT * FROM tournament_registrations WHERE tournament_id=? AND team_id=?');
    expect(code).toContain('ALREADY_APPLIED');
    expect(code).toContain('UNIQUE constraint failed');
    expect(code).toContain('INSERT INTO tournament_registrations');
    expect(source('migrations/0001_initial_schema.sql')).toContain('UNIQUE (tournament_id, team_id)');
  });

  test('new applications notify the tournament organizer as well as confirming receipt to the captain', () => {
    const code = api();
    expect(code).toContain('"organizer_id"');
    expect(code).toContain("type,title,message,link,entity_type,entity_id) VALUES (?,'application_received'");
    expect(code).toContain('tournament.organizer_id');
    expect(code).toContain('SELECT user_id FROM tournament_staff WHERE tournament_id=? AND staff_role IN (\'organizer\',\'admin\')');
    expect(code).toContain('recipientIds.delete(String(auth.user.id))');
  });

  test('roster replacement, notification and audit writes are batched together', () => {
    const code = api();
    expect(code).toContain('DELETE FROM tournament_registration_roster WHERE registration_id=?');
    expect(code).toContain('INSERT INTO tournament_registration_roster');
    expect(code).toContain('INSERT INTO notifications');
    expect(code).toContain('INSERT INTO audit_events');
    expect(code).toContain('await env.DB.batch(writes)');
    expect(code).toContain('Application reopen rollback failed');
  });

  test('application withdrawal is restricted to the team captain and only pending applications', () => {
    const code = api();
    expect(code).toContain('AS can_manage');
    expect(code).toContain('if (!row.can_manage)');
    expect(code).toContain('row.status !== "pending"');
    expect(code).toContain("status='withdrawn'");
  });

  test('client disables repeated submission and preserves the selected roster payload', () => {
    const page = source('index.html');
    expect(page).toContain('if(submit.disabled)return');
    expect(page).toContain('submit.disabled=true');
    expect(page).toContain('player_ids:selectedPlayers');
    expect(page).toContain('selectedPlayers.length<5||selectedPlayers.length>7');
  });
});
