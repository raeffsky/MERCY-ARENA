import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const clauses = ["1 = 1"];
  const values = [];
  const tournamentId = url.searchParams.get("tournament_id");
  const status = url.searchParams.get("status");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (tournamentId) { clauses.push("tournament_id = ?"); values.push(tournamentId); }
  if (status) { clauses.push("status = ?"); values.push(status); }
  if (from) { clauses.push("scheduled_at >= ?"); values.push(from); }
  if (to) { clauses.push("scheduled_at <= ?"); values.push(to); }
  const { results } = await env.DB.prepare(`SELECT id,tournament_id,round_number,bracket,match_number,scheduled_at,status,team_a_id,team_b_id,score_a,score_b,winner_team_id,result_source,result_verified_at,created_at FROM matches WHERE ${clauses.join(" AND ")} ORDER BY scheduled_at IS NULL, scheduled_at ASC LIMIT ?`).bind(...values, limit).all();
  return json(publicList(results || [], limit));
}
