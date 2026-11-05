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
      return { advanced: true, next_match_id: link.next_match_id };
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

  return { advanced: routes.length > 0, final: routes.length === 0 };
}
