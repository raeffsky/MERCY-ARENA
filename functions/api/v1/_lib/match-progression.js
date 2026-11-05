export async function advanceWinner(db, matchId, winnerTeamId) {
  const link = await db.prepare("SELECT next_match_id,next_slot FROM match_progression WHERE match_id=?").bind(matchId).first();
  if (!link) return { advanced: false, final: true };
  const column = link.next_slot;
  if (column !== "team_a_id" && column !== "team_b_id") throw new Error("Invalid progression slot");
  const next = await db.prepare("SELECT id,team_a_id,team_b_id FROM matches WHERE id=?").bind(link.next_match_id).first();
  if (!next) throw new Error("Next bracket match not found");
  const current = next[column];
  if (current != null && String(current) !== String(winnerTeamId)) throw new Error("Bracket slot already contains another team");
  await db.prepare("UPDATE matches SET " + column + "=?,updated_at=? WHERE id=?").bind(winnerTeamId, new Date().toISOString(), link.next_match_id).run();
  return { advanced: true, next_match_id: link.next_match_id };
}
