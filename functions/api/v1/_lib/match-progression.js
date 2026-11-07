import { deriveTournamentPlacements, placementGroup, pointsForPlacement } from "./circuit-scoring.mjs";
import { createAuditEventId } from "./audit.js";

export async function finalizeCircuitTournament(db, tournamentId) {
  const tournament = await db.prepare(
    "SELECT id,title,format,season_id,status FROM tournaments WHERE id=? LIMIT 1"
  ).bind(tournamentId).first();
  if (!tournament || tournament.status !== "completed" || tournament.season_id == null) {
    return { finalized: false, reason: "not_circuit_tournament" };
  }

  const season = await db.prepare("SELECT id,status FROM seasons WHERE id=? LIMIT 1").bind(tournament.season_id).first();
  if (!season || !["active","completed"].includes(season.status)) {
    return { finalized: false, reason: "season_not_active" };
  }

  const qualifier = await db.prepare(
    "SELECT awards_points FROM circuit_qualifiers WHERE tournament_id=? LIMIT 1"
  ).bind(tournamentId).first().catch((error) => {
    if (/no such table/i.test(String(error?.message || error))) return null;
    throw error;
  });
  const awardPoints = !qualifier || Number(qualifier.awards_points) === 1;
  const { results: matches } = await db.prepare(
    "SELECT id,bracket,round_number,status,team_a_id,team_b_id,score_a,score_b,winner_team_id FROM matches WHERE tournament_id=? ORDER BY bracket,round_number,match_number"
  ).bind(tournamentId).all();
  const { results: registrations } = await db.prepare(
    "SELECT team_id FROM tournament_registrations WHERE tournament_id=? AND status='approved' ORDER BY team_id"
  ).bind(tournamentId).all();
  const approvedTeams = new Set((registrations || []).map((row) => String(row.team_id)));
  const placements = deriveTournamentPlacements(tournament.format, matches || []);
  const placedTeams = new Set(placements.map((row) => String(row.team_id)));
  if (approvedTeams.size < 2 || approvedTeams.size !== placedTeams.size ||
      [...approvedTeams].some((teamId) => !placedTeams.has(teamId))) {
    throw new Error("Final placements do not match approved tournament registrations");
  }

  let rules = [];
  try {
    const result = await db.prepare(
      "SELECT place_from,place_to,points FROM circuit_scoring_rules WHERE season_id=? ORDER BY place_from"
    ).bind(tournament.season_id).all();
    rules = result.results || [];
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) {
      return { finalized: false, reason: "circuit_migration_required" };
    }
    throw error;
  }

  const now = new Date().toISOString();
  const statements = [];
  for (const result of placements) {
    const placement = Number(result.placement);
    const points = pointsForPlacement(placement, rules);
    const pointsAwarded = awardPoints ? points : 0;
    const group = placementGroup(placement);
    statements.push(db.prepare(
      "INSERT OR IGNORE INTO circuit_tournament_results (season_id,tournament_id,team_id,placement,placement_group,points_awarded,is_qualifier,finalized_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(tournament.season_id, tournamentId, result.team_id, placement, group, pointsAwarded, qualifier ? 1 : 0, now));
    if (awardPoints && points > 0) {
      statements.push(db.prepare(
        "INSERT INTO circuit_point_transactions (season_id,team_id,tournament_id,result_id,points_delta,transaction_type,reason) " +
        "SELECT ?,?,?,r.id,?,'placement_award',? FROM circuit_tournament_results r " +
        "WHERE r.season_id=? AND r.tournament_id=? AND r.team_id=? " +
        "AND NOT EXISTS (SELECT 1 FROM circuit_point_transactions tx WHERE tx.result_id=r.id AND tx.transaction_type='placement_award')"
      ).bind(tournament.season_id, result.team_id, tournamentId, points,
        "Итоговое место: " + placement, tournament.season_id, tournamentId, result.team_id));
    }
  }
  statements.push(db.prepare(
    "INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,NULL,'circuit_tournament_finalized','tournament',?,?)"
  ).bind(await createAuditEventId(db), String(tournamentId), JSON.stringify({
    season_id: tournament.season_id,
    format: tournament.format,
    points_awarded: awardPoints,
    placements: placements.map((row) => ({ team_id: row.team_id, placement: row.placement, points: awardPoints ? pointsForPlacement(row.placement, rules) : 0 }))
  })));
  await db.batch(statements);
  return { finalized: true, teams: placements.length };
}

export async function prepareFinalizedCircuitCorrection(db, tournamentId, actorId, matchId, correctedResult) {
  const tournament = await db.prepare(
    "SELECT id,format,season_id,status FROM tournaments WHERE id=? LIMIT 1"
  ).bind(tournamentId).first();
  if (!tournament || tournament.status !== "completed" || tournament.season_id == null) {
    throw new Error("Турнир не имеет завершённого Circuit-результата для пересчёта.");
  }

  let qualifier = null;
  try {
    qualifier = await db.prepare(
      "SELECT id,awards_points FROM circuit_qualifiers WHERE tournament_id=? LIMIT 1"
    ).bind(tournamentId).first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    throw new Error("Миграция MERCY CIRCUIT не применена. Пересчёт очков недоступен.");
  }
  if (qualifier) {
    throw new Error("Это квалификационный турнир. Его результаты связаны с уже выданными слотами чемпионата, поэтому автоматическая корректировка пока заблокирована.");
  }

  const lockedEntries = await db.prepare(
    "SELECT COUNT(*) AS total FROM circuit_championship_entries WHERE season_id=?"
  ).bind(tournament.season_id).first();
  if (Number(lockedEntries?.total || 0) > 0) {
    throw new Error("Состав MERCY CHAMPIONSHIP уже зафиксирован. Сначала нужно отдельно пересчитать квалификационные слоты.");
  }

  const { results: matches } = await db.prepare(
    "SELECT id,bracket,round_number,status,team_a_id,team_b_id,score_a,score_b,winner_team_id FROM matches WHERE tournament_id=? ORDER BY bracket,round_number,match_number"
  ).bind(tournamentId).all();
  const correctedMatches = (matches || []).map((match) => String(match.id) === String(matchId)
    ? { ...match, score_a: correctedResult.score_a, score_b: correctedResult.score_b, winner_team_id: correctedResult.winner_team_id }
    : match);
  if (!correctedMatches.some((match) => String(match.id) === String(matchId))) {
    throw new Error("Матч не найден в завершённой сетке турнира.");
  }
  const placements = deriveTournamentPlacements(tournament.format, correctedMatches);
  const { results: registrations } = await db.prepare(
    "SELECT team_id FROM tournament_registrations WHERE tournament_id=? AND status='approved' ORDER BY team_id"
  ).bind(tournamentId).all();
  const approvedTeams = new Set((registrations || []).map((row) => String(row.team_id)));
  const placedTeams = new Set(placements.map((row) => String(row.team_id)));
  if (approvedTeams.size < 2 || approvedTeams.size !== placedTeams.size ||
      [...approvedTeams].some((teamId) => !placedTeams.has(teamId))) {
    throw new Error("Пересчитанные места не совпадают с утверждёнными командами турнира.");
  }

  const { results: existing } = await db.prepare(
    "SELECT id,team_id,placement,placement_group,points_awarded,is_qualifier FROM circuit_tournament_results WHERE season_id=? AND tournament_id=?"
  ).bind(tournament.season_id, tournamentId).all();
  const existingByTeam = new Map((existing || []).map((row) => [String(row.team_id), row]));
  if (existingByTeam.size !== placedTeams.size ||
      [...placedTeams].some((teamId) => !existingByTeam.has(teamId))) {
    throw new Error("История Circuit не совпадает с составом турнира. Автоматический пересчёт остановлен.");
  }

  const { results: ledger } = await db.prepare(
    "SELECT result_id,SUM(points_delta) AS balance FROM circuit_point_transactions WHERE season_id=? AND tournament_id=? AND result_id IS NOT NULL GROUP BY result_id"
  ).bind(tournament.season_id, tournamentId).all();
  const ledgerByResult = new Map((ledger || []).map((row) => [String(row.result_id), Number(row.balance || 0)]));
  for (const row of existing || []) {
    if ((ledgerByResult.get(String(row.id)) || 0) !== Number(row.points_awarded || 0)) {
      throw new Error("Баланс журнала Circuit не совпадает с итоговой записью. Нужна ручная сверка.");
    }
  }

  const { results: rules } = await db.prepare(
    "SELECT place_from,place_to,points FROM circuit_scoring_rules WHERE season_id=? ORDER BY place_from"
  ).bind(tournament.season_id).all();
  const awardPoints = !qualifier || Number(qualifier.awards_points) === 1;
  const timestamp = new Date().toISOString();
  const statements = [];
  const changes = [];
  for (const result of placements) {
    const teamId = String(result.team_id);
    const previous = existingByTeam.get(teamId);
    const placement = Number(result.placement);
    const group = placementGroup(placement);
    const nextPoints = awardPoints && Number(previous.is_qualifier) !== 1
      ? pointsForPlacement(placement, rules || []) : 0;
    const oldPoints = Number(previous.points_awarded || 0);
    const placementChanged = Number(previous.placement) !== placement || previous.placement_group !== group;
    const pointsDelta = nextPoints - oldPoints;
    if (!placementChanged && pointsDelta === 0) continue;

    statements.push(db.prepare(
      "UPDATE circuit_tournament_results SET placement=?,placement_group=?,points_awarded=?,finalized_at=? WHERE id=? AND placement=? AND points_awarded=?"
    ).bind(placement,group,nextPoints,timestamp,previous.id,previous.placement,previous.points_awarded));
    statements.push(db.prepare(
      "INSERT INTO audit_events (action,entity_type,entity_id) SELECT NULL,'circuit_result_guard','0' WHERE changes()=0"
    ));
    if (pointsDelta !== 0) {
      statements.push(db.prepare(
        "INSERT INTO circuit_point_transactions (season_id,team_id,tournament_id,result_id,points_delta,transaction_type,reason,created_by) VALUES (?,?,?,?,?,'correction',?,?)"
      ).bind(tournament.season_id,previous.team_id,tournamentId,previous.id,pointsDelta,
        "Корректировка результата матча #" + matchId + ": место " + previous.placement + " → " + placement,
        actorId));
    }
    changes.push({
      team_id: previous.team_id,
      from_placement: Number(previous.placement),
      to_placement: placement,
      points_delta: pointsDelta
    });
  }

  if (changes.length) {
    statements.push(db.prepare(
      "INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,'circuit_result_corrected','tournament',?,?,?)"
    ).bind(await createAuditEventId(db),actorId,String(tournamentId),
      JSON.stringify({ match_id: String(matchId), changes: changes.map((row) => ({ team_id: row.team_id, placement: row.from_placement })) }),
      JSON.stringify({ match_id: String(matchId), changes })));
  }
  return {
    statements,
    summary: {
      reconciled: true,
      teams_updated: changes.length,
      points_delta: changes.reduce((sum,row)=>sum+row.points_delta,0),
      changes
    }
  };
}

export async function completeTournamentIfReady(db, tournamentId) {
  const state = await db.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN m.status='completed' THEN 1 ELSE 0 END) AS completed " +
    "FROM matches m WHERE m.tournament_id=? AND NOT (" +
    "m.bracket='final' AND m.round_number=2 AND m.status='cancelled' AND EXISTS (" +
    "SELECT 1 FROM matches gf WHERE gf.tournament_id=m.tournament_id AND gf.bracket='final' " +
    "AND gf.round_number=1 AND gf.status='completed' AND gf.winner_team_id=gf.team_a_id))"
  ).bind(tournamentId).first();
  // Cancelled matches are not played results. A tournament with cancelled or
  // postponed fixtures must never be finalized as if every match had finished.
  if (Number(state?.total || 0) === 0 || Number(state?.completed || 0) !== Number(state?.total || 0)) return false;
  const updated = await db.prepare(
    "UPDATE tournaments SET status='completed',updated_at=? WHERE id=? AND status IN ('published','active')"
  ).bind(new Date().toISOString(), tournamentId).run();
  try {
    await finalizeCircuitTournament(db, tournamentId);
  } catch (error) {
    console.error("MERCY CIRCUIT finalization pending:", error);
  }
  return Boolean(updated.meta?.changes);
}

export async function advanceWinner(db, matchId, winnerTeamId) {
  const match = await db.prepare(
    "SELECT id,tournament_id,bracket,round_number,team_a_id,team_b_id FROM matches WHERE id=? LIMIT 1"
  ).bind(matchId).first();
  if (!match) throw new Error("Completed match not found");

  const winner = String(winnerTeamId);
  const teamA = match.team_a_id == null ? null : String(match.team_a_id);
  const teamB = match.team_b_id == null ? null : String(match.team_b_id);
  const loserTeamId = winner === teamA ? match.team_b_id : winner === teamB ? match.team_a_id : null;
  if (loserTeamId == null) throw new Error("Winner is not a participant in the completed match");

  let routes = [];
  try {
    const result = await db.prepare(
      "SELECT outcome,next_match_id,next_slot FROM match_advancement WHERE match_id=? ORDER BY outcome"
    ).bind(matchId).all();
    routes = result.results || [];
  } catch (error) {
    // Older installations may not have applied migration 0016 yet. Keep the
    // existing Single Elimination progression operational during rollout.
    if (!/no such table/i.test(String(error?.message || error))) throw error;
  }

  if (routes.length) {
    const statements = routes.map((route) => {
      if (route.next_slot !== "team_a_id" && route.next_slot !== "team_b_id") throw new Error("Invalid progression slot");
      const entrant = route.outcome === "winner" ? winnerTeamId : route.outcome === "loser" ? loserTeamId : null;
      if (entrant == null) throw new Error("Invalid advancement outcome");
      return db.prepare(
        "UPDATE matches SET " + route.next_slot + "=?,updated_at=? WHERE id=? AND (" + route.next_slot + " IS NULL OR " + route.next_slot + "=?)"
      ).bind(entrant, new Date().toISOString(), route.next_match_id, entrant);
    });
    const updates = await db.batch(statements);
    if (updates.some((result) => result.meta?.changes === 0)) throw new Error("Bracket slot was changed by another result");
  } else {
    const link = await db.prepare("SELECT next_match_id,next_slot FROM match_progression WHERE match_id=?").bind(matchId).first();
    if (link) {
      const column = link.next_slot;
      if (column !== "team_a_id" && column !== "team_b_id") throw new Error("Invalid progression slot");
      const updated = await db.prepare("UPDATE matches SET " + column + "=?,updated_at=? WHERE id=? AND (" + column + " IS NULL OR " + column + "=?)")
        .bind(winnerTeamId, new Date().toISOString(), link.next_match_id, winnerTeamId).run();
      if (updated.meta?.changes === 0) throw new Error("Bracket slot was changed by another result");
      const tournamentCompleted = await completeTournamentIfReady(db, match.tournament_id);
      return { advanced: true, next_match_id: link.next_match_id, tournament_completed: tournamentCompleted };
    }
  }

  // The lower-bracket finalist must beat the upper-bracket finalist twice.
  // The reset final is pre-created as cancelled and is activated only when
  // the lower-bracket entrant wins the first grand final.
  if (match.bracket === "final" && Number(match.round_number) === 1 && String(match.team_b_id) === winner) {
    const reset = await db.prepare(
      "SELECT id,status FROM matches WHERE tournament_id=? AND bracket='final' AND round_number=2 LIMIT 1"
    ).bind(match.tournament_id).first();
    if (reset) {
      await db.prepare(
        "UPDATE matches SET team_a_id=?,team_b_id=?,status='scheduled',updated_at=? WHERE id=? AND status='cancelled'"
      ).bind(match.team_a_id, match.team_b_id, new Date().toISOString(), reset.id).run();
      return { advanced: false, final_reset: true, next_match_id: reset.id };
    }
  }

  const tournamentCompleted = await completeTournamentIfReady(db, match.tournament_id);
  return { advanced: routes.length > 0, final: routes.length === 0, tournament_completed: tournamentCompleted };
}
