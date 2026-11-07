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
    expect(admin).toContain('reopenedTournament');
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
