import { buildCircuitRanking, deriveTournamentPlacements, placementGroup, pointsForPlacement } from "./circuit-scoring.js";
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
    const group = placementGroup(placement);
    statements.push(db.prepare(
      "INSERT OR IGNORE INTO circuit_tournament_results (season_id,tournament_id,team_id,placement,placement_group,points_awarded,finalized_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(tournament.season_id, tournamentId, result.team_id, placement, group, points, now));
    statements.push(db.prepare(
      "INSERT INTO circuit_point_transactions (season_id,team_id,tournament_id,result_id,points_delta,transaction_type,reason) " +
      "SELECT ?,?,?,r.id,?,'placement_award',? FROM circuit_tournament_results r " +
      "WHERE r.season_id=? AND r.tournament_id=? AND r.team_id=? " +
      "AND NOT EXISTS (SELECT 1 FROM circuit_point_transactions tx WHERE tx.result_id=r.id AND tx.transaction_type='placement_award')"
    ).bind(tournament.season_id, result.team_id, tournamentId, points,
      "Итоговое место: " + placement, tournament.season_id, tournamentId, result.team_id));
  }
  statements.push(db.prepare(
    "INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,NULL,'circuit_tournament_finalized','tournament',?,?)"
  ).bind(await createAuditEventId(db), String(tournamentId), JSON.stringify({
    season_id: tournament.season_id,
    format: tournament.format,
    placements: placements.map((row) => ({ team_id: row.team_id, placement: row.placement, points: pointsForPlacement(row.placement, rules) }))
  })));
  await db.batch(statements);
  return { finalized: true, teams: placements.length };
}

async function completeTournamentIfReady(db, tournamentId) {
  const pending = await db.prepare(
    "SELECT COUNT(*) AS total FROM matches WHERE tournament_id=? AND status NOT IN ('completed','cancelled')"
  ).bind(tournamentId).first();
  if (Number(pending?.total || 0) > 0) return false;
  const updated = await db.prepare(
    "UPDATE tournaments SET status='completed',updated_at=? WHERE id=? AND status IN ('published','active')"
  ).bind(new Date().toISOString(), tournamentId).run();
  if (updated.meta?.changes) {
    try {
      await finalizeCircuitTournament(db, tournamentId);
    } catch (error) {
      console.error("MERCY CIRCUIT finalization pending:", error);
    }
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
