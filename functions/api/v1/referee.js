import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser } from "./_lib/session-auth.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const session = await getSessionUser(request, env);
  if (session.error) return session.error;
  if (!session.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт судьи." } }, 401);
  const { results } = await env.DB.prepare(
    "SELECT m.id,m.tournament_id,m.round_number,m.bracket,m.match_number,m.scheduled_at,m.status," +
    "m.team_a_id,m.team_b_id,m.score_a,m.score_b,m.winner_team_id,m.result_source,m.result_verified_at," +
    "t.title AS tournament_title,t.status AS tournament_status,ta.name AS team_a_name,tb.name AS team_b_name," +
    "mr.series_format,rs.status AS result_submission_status,rs.score_a AS proposed_score_a," +
    "rs.score_b AS proposed_score_b,rs.dispute_reason " +
    "FROM tournament_staff s JOIN tournaments t ON t.id=s.tournament_id " +
    "JOIN matches m ON m.tournament_id=t.id " +
    "LEFT JOIN teams ta ON ta.id=m.team_a_id LEFT JOIN teams tb ON tb.id=m.team_b_id " +
    "LEFT JOIN match_rooms mr ON mr.match_id=m.id " +
    "LEFT JOIN match_result_submissions rs ON rs.match_id=m.id " +
    "WHERE s.user_id=? AND s.staff_role='referee' " +
    "ORDER BY CASE m.status WHEN 'in_progress' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'postponed' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END," +
    "m.scheduled_at IS NULL,m.scheduled_at,m.tournament_id,m.round_number,m.match_number LIMIT 200"
  ).bind(session.user.id).all();
  return json({ data: results || [] }, 200, { "Cache-Control": "no-store, private" });
}

export function onRequestPost() { return methodNotAllowed("GET"); }
export function onRequestPut() { return methodNotAllowed("GET"); }
export function onRequestDelete() { return methodNotAllowed("GET"); }
