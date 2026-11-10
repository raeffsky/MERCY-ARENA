const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test.describe('MERCY ARENA API guardrails', () => {
  test('global administration and Circuit mutations are restricted to the platform owner', () => {
    for (const file of [
      'functions/api/v1/admin.js',
      'functions/api/v1/circuit/qualify.js',
      'functions/api/v1/uploads/season-cover.js',
      'functions/api/v1/uploads/tournament-poster.js'
    ]) {
      expect(source(file), file).toContain('isOwnerAccount');
    }
  });

  test('administrator audit log is owner-only and read-only', () => {
    const admin = source('functions/api/v1/admin.js');
    const getHandler = admin.slice(admin.indexOf('export async function onRequestGet'), admin.indexOf('export async function onRequestPost'));
    const postHandler = admin.slice(admin.indexOf('export async function onRequestPost'));
    expect(getHandler).toContain('const auth = await authorize(request, env)');
    expect(getHandler).toContain('resource === "audit"');
    expect(getHandler).toContain('FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id');
    expect(admin).toContain('!session.user.roles.includes("administrator") || !isOwnerAccount(session.user, env)');
    expect(postHandler).not.toContain('resource === "audit"');
  });

  test('organizers can generate brackets only for their own tournaments', () => {
    const brackets = source('functions/api/v1/brackets.js');
    expect(brackets).toContain('isOwnerAccount');
    expect(brackets).toContain('String(tournament.organizer_id) !== String(auth.user.id)');
  });

  test('public match schedule hides placeholder matches without assigned teams', () => {
    const matches = source('functions/api/v1/matches.js');
    expect(matches).toContain('(m.team_a_id IS NOT NULL OR m.team_b_id IS NOT NULL)');
  });

  test('public tournament details count only active registered teams', () => {
    const tournaments = source('functions/api/v1/tournaments.js');
    expect(tournaments).toContain("registered_team.status='active'");
    expect(tournaments).toContain("tm.status='active'");
  });

  test('tournament application capacity matches public counts and excludes archived teams', () => {
    const applications = source('functions/api/v1/applications.js');
    const tournaments = source('functions/api/v1/tournaments.js');
    expect(applications).toContain("capacity_team.status='active' AND capacity_team.archived_at IS NULL");
    expect(tournaments).toContain("applying_team.status='active' AND applying_team.archived_at IS NULL");
    expect(applications).toContain('opensAt !== null && !Number.isFinite(opensAt)');
    expect(applications).toContain('closesAt !== null && !Number.isFinite(closesAt)');
  });

  test('tournament applications ignore archived roster members and archived teams when checking capacity', () => {
    const applications = source('functions/api/v1/applications.js');
    expect(applications).toContain("roster_player.archived_at IS NULL");
    expect(applications).toContain("p.archived_at IS NULL");
    expect(applications).toContain("capacity_team.status='active' AND capacity_team.archived_at IS NULL");
    expect(applications).not.toContain("SELECT COUNT(*) AS total FROM tournament_registrations WHERE tournament_id=? AND status IN ('pending','approved')");
  });

  test('CROWN defense selector only offers matches between the chosen challenger and champion', () => {
    const page = source('index.html');
    expect(page).toContain('crownMatchSelect.disabled=!eligibleMatches.length');
    expect(page).toContain("sides.includes(String(current.team_id))&&sides.includes(challengerId)");
    expect(page).toContain('Сначала выбери претендента');
  });

  test('MERCY CROWN permits only one pending defense per reign and requires a public match', () => {
    const crown = source('functions/api/v1/crown.js');
    const migration = source('migrations/0022_mercy_crown_single_pending_challenge.sql');
    expect(crown).toContain("t.status AS tournament_status");
    expect(crown).toContain('new Set([String(match.team_a_id),String(match.team_b_id)]).size !== 2');
    expect(crown).toContain('CROWN_CHALLENGE_PENDING');
    expect(migration).toContain("ON mercy_crown_challenges(reign_id)");
    expect(migration).toContain("WHERE status='scheduled'");
  });

  test('MERCY CROWN accepts numeric IDs and uses a guarded single-winner transition', () => {
    const crown = source('functions/api/v1/crown.js');
    expect(crown).toContain('/^\\d+$/');
    expect(crown).toContain("status='scheduled' AND reign_id=?");
    expect(crown).toContain("status='decided' AND decided_at=? AND winner_team_id=?");
    expect(crown).toContain('MATCH_TEAMS_CHANGED');
    expect(crown).toContain('CROWN_ALREADY_HELD');
  });

  test('application withdrawal recognizes the same captain identities as submission', () => {
    const applications = source('functions/api/v1/applications.js');
    expect(applications).toContain('AS can_manage');
    expect(applications).toContain("tr.roster_role='captain' AND p.user_id=?");
  });

  test('players cannot reactivate an archived profile through the self-service endpoint', () => {
    const players = source('functions/api/v1/players.js');
    expect(players).toContain('SELECT id,archived_at FROM players WHERE user_id=?');
    expect(players).toContain('PROFILE_ARCHIVED');
    expect(players).toContain('profile_status=?,updated_at=? WHERE user_id=?');
    expect(players).not.toContain('archived_at=NULL,updated_at=? WHERE user_id=?');
  });

  test('public player and team directories consistently hide archived entities', () => {
    const players = source('functions/api/v1/players.js');
    const teams = source('functions/api/v1/teams.js');
    const rankings = source('functions/api/v1/rankings.js');
    expect(players).toContain("p.archived_at IS NULL");
    expect(players).toContain("archived_at IS NULL");
    expect(teams).toContain("t.archived_at IS NULL");
    expect(teams).toContain("archived_at IS NULL");
    expect(rankings).toContain("t.archived_at IS NULL");
    expect(rankings).toContain("p.archived_at IS NULL");
  });

  test('player and team public stats only use published tournament results', () => {
    const players = source('functions/api/v1/players.js');
    const teams = source('functions/api/v1/teams.js');
    const scout = source('functions/api/v1/scout.js');
    expect(players).toContain("tour.published_at IS NOT NULL AND tour.status!='draft'");
    expect(players).toContain("t.published_at IS NOT NULL AND t.status!='draft'");
    expect(teams).toContain("tour.published_at IS NOT NULL AND tour.status!='draft'");
    expect(teams).toContain("t.published_at IS NOT NULL AND t.status!='draft'");
    expect(scout).toContain("p0.archived_at IS NULL");
  });

  test('bracket generation and MERCY CIRCUIT qualification exclude archived teams', () => {
    const brackets = source('functions/api/v1/brackets.js');
    const qualify = source('functions/api/v1/circuit/qualify.js');
    const ranking = source('functions/api/v1/circuit/ranking.js');
    expect(brackets).toContain("tm.status='active' AND tm.archived_at IS NULL");
    expect(qualify).toContain("WHERE t.archived_at IS NULL AND (EXISTS");
    expect(ranking).toContain("WHERE t.archived_at IS NULL AND (EXISTS");
  });

  test('team invitation creation rechecks active team and free player atomically', () => {
    const members = source('functions/api/v1/team-members.js');
    expect(members).toContain("INSERT INTO team_invites (team_id,player_id,invited_by,status,created_at) SELECT");
    expect(members).toContain("WHERE id=team_invites.team_id AND captain_id=? AND status='active' AND archived_at IS NULL");
    expect(members).toContain("profile_status='approved' AND archived_at IS NULL AND team_id IS NULL");
    expect(members).toContain('TEAM_OR_PLAYER_CHANGED');
  });

  test('invite acceptance is atomic with active-team and roster state', () => {
    const members = source('functions/api/v1/team-members.js');
    expect(members).toContain("status='pending' AND EXISTS (SELECT 1 FROM teams WHERE id=team_invites.team_id AND status='active' AND archived_at IS NULL)");
    expect(members).toContain("status='accepted' AND responded_at=?");
    expect(members).toContain("status='active' AND archived_at IS NULL");
    expect(members).toContain('TEAM_ARCHIVED_DURING_ACCEPT');
  });

  test('team captain transfer and invite acceptance recheck active team state atomically', () => {
    const members = source('functions/api/v1/team-members.js');
    expect(members).toContain("WHERE id=? AND captain_id=? AND status='active' AND archived_at IS NULL");
    expect(members).toContain("EXISTS (SELECT 1 FROM teams WHERE id=? AND status='active' AND archived_at IS NULL)");
    expect(members).toContain("p.profile_status='approved' AND p.archived_at IS NULL");
  });

  test('team roster limits do not count archived players as active members', () => {
    const members = source('functions/api/v1/team-members.js');
    expect(members).toContain("JOIN players p ON p.id=tr.player_id AND p.archived_at IS NULL");
    expect(members).toContain("p.archived_at IS NULL AND (p.team_id=? OR p.id IN");
    expect(members).toContain("roster_player.archived_at IS NULL");
  });

  test('organizer API is role-gated and scopes all records to the assigned organizer', () => {
    const organizer = source('functions/api/v1/organizer.js');
    expect(organizer).toContain('session.user.roles.includes("organizer")');
    expect(organizer).toContain('organizer_id=?');
    expect(organizer).toContain('String(before.organizer_id)!==String(auth.user.id)');
    expect(organizer).toContain('sameOrigin(request,env)');
    expect(organizer).toContain("result_source='organizer_manual'");
    expect(organizer).toContain('advanceWinner(env.DB,id,winner)');
    expect(organizer).toContain('BRACKET_FORMAT_LOCKED');
    expect(organizer).toContain('TEAM_LIMIT_BELOW_OCCUPIED');
  });

  test('only the platform owner can grant or revoke organizer access', () => {
    const admin = source('functions/api/v1/admin.js');
    const page = source('index.html');
    expect(admin).toContain('resource === "users" && action === "set_organizer"');
    expect(admin).toContain("INSERT INTO user_roles (user_id,role,granted_by) VALUES (?,'organizer',?)");
    expect(admin).toContain("DELETE FROM user_roles WHERE user_id=? AND role='organizer'");
    expect(page).toContain('data-organizer-toggle');
    expect(page).toContain("me.roles||[]).includes('organizer')");
    expect(page).toContain('initOrganizerDashboard');
  });

  test('admin application overview hides archived teams from approved bracket counts', () => {
    const admin = source('functions/api/v1/admin.js');
    const page = source('index.html');
    expect(admin).toContain("tm.archived_at AS team_archived_at");
    expect(page).toContain("x.status==='approved'&&x.team_status==='active'&&!x.team_archived_at");
    expect(page).toContain('Команда неактивна или архивирована');
  });

  test('admin cannot approve an application for an archived team or count archived teams toward capacity', () => {
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain("tm.archived_at AS team_archived_at");
    expect(admin).toContain('before.team_status !== "active" || before.team_archived_at != null');
    expect(admin).toContain("active_team.status='active' AND active_team.archived_at IS NULL");
    expect(admin).toContain("capacity_team.status='active' AND capacity_team.archived_at IS NULL");
  });

  test('team archive is blocked while the team has active matches or holds/defends MERCY CROWN', () => {
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain("AS active_matches");
    expect(admin).toContain("AS active_reign");
    expect(admin).toContain("AS active_challenges");
    expect(admin).toContain("status IN ('scheduled','in_progress')");
    expect(admin).toContain('Команду нельзя архивировать');
  });

  test('admin archives entities without deleting history and restores them safely', () => {
    const admin = source('functions/api/v1/admin.js');
    const page = source('index.html');
    expect(admin).toContain('if (action === "restore")');
    expect(admin).toContain("archived_at=?,updated_at=?");
    expect(admin).toContain("UPDATE team_invites SET status='cancelled',responded_at=?");
    expect(admin).toContain("archived_at=NULL,status='inactive'");
    expect(admin).toContain("archived_at=NULL,profile_status='pending'");
    expect(page).toContain('data-restore');
    expect(page).toContain('>Архивировать</button>');
  });

  test('team invitations cannot target archived profiles or archived teams', () => {
    const members = source('functions/api/v1/team-members.js');
    expect(members).toContain("p.archived_at IS NULL");
    expect(members).toContain("t.archived_at IS NULL");
    expect(members).toContain("archived_at IS NULL");
  });

  test('MERCY SCOUT exposes only approved, non-archived players and verified starter matches', () => {
    const scout = source('functions/api/v1/scout.js');
    expect(scout).toContain("p.profile_status='approved'");
    expect(scout).toContain("p.archived_at IS NULL");
    expect(scout).toContain("rr.roster_role='starter'");
    expect(scout).toContain("m.status='completed' AND m.result_verified_at IS NOT NULL");
    expect(scout).toContain("tour.published_at IS NOT NULL AND tour.status!='draft'");
    expect(scout).toContain('INVALID_ROLE');
  });

  test('application form prevents duplicate submits and invalid rosters before sending', () => {
    const page = source('index.html');
    expect(page).toContain('if(submit.disabled)return');
    expect(page).toContain('selectedPlayers.length<5||selectedPlayers.length>7');
    expect(page).toContain('player_ids:selectedPlayers');
  });

  test('logout rejects requests without an Origin header', () => {
    const logout = source('functions/api/v1/auth/logout.js');
    expect(logout).toContain('const origin = request.headers.get("origin")');
    expect(logout).toContain('if (!origin || !sameOrigin(request, env))');
  });

  test('declining a team invite is conditional and does not notify after a competing acceptance', () => {
    const members = source('functions/api/v1/team-members.js');
    expect(members).toContain("status='declined' AND responded_at=?");
    expect(members).toContain("if (!writes[0]?.meta?.changes) return json({ error: { code: \"INVITE_NOT_FOUND\"");
  });

  test('public match and ranking APIs exclude unpublished tournaments', () => {
    expect(source('functions/api/v1/matches.js')).toContain("visible_tournament.published_at IS NOT NULL");
    const rankings = source('functions/api/v1/rankings.js');
    expect(rankings).toContain("tour.published_at IS NOT NULL");
    expect(rankings).toContain("tour.status!='draft'");
  });

  test('manual match results cannot be created as completed and completion is atomic', () => {
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain('action === "create" && payload.status === "completed"');
    expect(admin).toContain('const completingMatch = resource === "matches" && before.status !== "completed" && payload.status === "completed"');
    expect(admin).toContain('completingMatch ? " AND status!=\'completed\'" : ""');
    expect(admin).toContain('if (completingMatch && !updateResult.meta?.changes)');
    expect(admin).toContain('Одна команда не может играть сама с собой.');
  });

  test('organizer match list includes tournament, team names and schedule', () => {
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain('t.title AS tournament_title,t.status AS tournament_status,ta.name AS team_a_name,tb.name AS team_b_name');
    const page = source('index.html');
    expect(page).toContain("x.scheduled_at?dateLabel(x.scheduled_at):'Не назначено'");
    expect(page).toContain("x.team_a_name||('Команда #'+(x.team_a_id||'—'))");
  });

  test('application launch allows uneven Single Elimination brackets up to 32 teams', () => {
    const page = source('index.html');
    expect(page).toContain("(t.format==='single_elimination'&&approved>=2&&approved<=32)");
    expect(page).toContain("(t.format==='double_elimination'&&approved>=4&&approved<=32&&(approved&(approved-1))===0)");
  });

  test('cancelled and postponed matches cannot complete a tournament', () => {
    const progression = source('functions/api/v1/_lib/match-progression.js');
    expect(progression).toContain("SUM(CASE WHEN m.status='completed' THEN 1 ELSE 0 END) AS completed");
    expect(progression).toContain('Number(state?.completed || 0) !== Number(state?.total || 0)');
    expect(progression).toContain('Cancelled matches are not played results');
  });

  test('match rescheduling and cancellation preserve completed results', () => {
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain('payload.status === "in_progress" && (teamA == null || teamB == null)');
    expect(admin).toContain('existing.status === "completed" && payload.status && payload.status !== "completed"');
    const page = source('index.html');
    expect(page).toContain('для отмены выбери статус «Отменён»');
    expect(page).toContain("x.scheduled_at?dateLabel(x.scheduled_at):'Не назначено'");
  });

  test('completed match corrections guard downstream progression and keep an audit trail', () => {
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain('action === "correct_result"');
    expect(admin).toContain('before.tournament_status === "completed"');
    expect(admin).toContain('prepareMatchCorrectionCascade');
    expect(admin).toContain("Superseded by manual result correction");
    expect(admin).toContain("Superseded by corrected Grand Final result");
    expect(admin).toContain("Первый Grand Final завершённого MERCY CIRCUIT");
    expect(admin).toContain("status=?,score_a=NULL,score_b=NULL,winner_team_id=NULL");
    expect(admin).toContain('cascade_reset_matches');
    expect(admin).toContain('cascade_cancelled_matches: cascade.summary.cancelled_matches');
    expect(admin).toContain('reopenedTournament');
    expect(admin).toContain('tournament_reopened: reopenedTournament');
    expect(admin).toContain("UPDATE tournaments SET status='active'");
    expect(admin).toContain('Каскад потребует переиграть зависимые матчи');
    const cascade = source('functions/api/v1/_lib/match-correction-cascade.mjs');
    expect(cascade).toContain("validation_status='reviewed'");
    expect(cascade).toContain("result_verified_at=NULL");
    expect(cascade).toContain('Каскадная корректировка остановлена');
    expect(admin).toContain("match_result_corrected");
    const page = source('index.html');
    expect(page).toContain('data-correct-result');
    expect(page).toContain('затронутые матчи уже начаты или завершены');
    expect(page).toContain('Матчей для переигровки: ');
    expect(page).toContain("action:'correct_result'");
    expect(page).toContain('КОРРЕКТИРОВКА РЕЗУЛЬТАТА');
  });

  test('Double Elimination unused reset final does not block tournament completion', () => {
    const progression = source('functions/api/v1/_lib/match-progression.js');
    expect(progression).toContain("m.bracket='final' AND m.round_number=2 AND m.status='cancelled'");
    expect(progression).toContain('gf.winner_team_id=gf.team_a_id');
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain('t.status AS tournament_status');
    expect(admin).toContain('Расписание завершённого матча нельзя менять');
  });

  test('corrected final results re-evaluate tournament and Circuit completion', () => {
    const admin = source('functions/api/v1/admin.js');
    expect(admin).toContain('completeTournamentIfReady(env.DB, before.tournament_id)');
    expect(admin).toContain('const matchId = String(id ?? "").trim()');
    expect(admin).toContain('guardSuccessfulWrite');
    const progression = source('functions/api/v1/_lib/match-progression.js');
    expect(progression).toContain('export async function completeTournamentIfReady');
  });

  test('finalized Circuit result corrections append ledger deltas and update placements', () => {
    const admin = source('functions/api/v1/admin.js');
    const getHandler = admin.slice(admin.indexOf('export async function onRequestGet'), admin.indexOf('export async function onRequestPost'));
    const postHandler = admin.slice(admin.indexOf('export async function onRequestPost'));
    expect(getHandler).not.toContain('action === "correct_result"');
    expect(postHandler).toContain('action === "correct_result"');
    expect(postHandler).toContain('prepareFinalizedCircuitCorrection');
    expect(postHandler).toContain('t.season_id AS tournament_season_id');
    const progression = source('functions/api/v1/_lib/match-progression.js');
    expect(progression).toContain('transaction_type,reason,created_by');
    expect(progression).toContain("'correction'");
    expect(progression).toContain('UPDATE circuit_tournament_results SET placement=?,placement_group=?,points_awarded=?');
    expect(progression).toContain('Баланс журнала Circuit не совпадает');
    expect(progression).toContain('circuit_championship_entries');
  });
});
