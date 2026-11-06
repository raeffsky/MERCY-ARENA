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
  const { results } = await env.DB.prepare(`SELECT m.id,m.tournament_id,m.round_number,m.bracket,m.match_number,m.scheduled_at,m.status,m.team_a_id,m.team_b_id,ta.name AS team_a_name,ta.tag AS team_a_tag,ta.logo_url AS team_a_logo,tb.name AS team_b_name,tb.tag AS team_b_tag,tb.logo_url AS team_b_logo,m.score_a,m.score_b,m.winner_team_id,m.result_source,m.result_verified_at,m.created_at FROM matches m JOIN tournaments visible_tournament ON visible_tournament.id=m.tournament_id AND visible_tournament.published_at IS NOT NULL AND visible_tournament.status!='draft' LEFT JOIN teams ta ON ta.id=m.team_a_id LEFT JOIN teams tb ON tb.id=m.team_b_id WHERE ${clauses.join(" AND ")} ORDER BY CASE WHEN ? IS NOT NULL THEN round_number END ASC, scheduled_at IS NULL, scheduled_at ASC, round_number ASC, bracket ASC, match_number ASC LIMIT ?`).bind(...values, tournamentId, limit).all();
  return json(publicList(results || [], limit));
}
