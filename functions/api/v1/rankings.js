import { json, databaseUnavailable, parseLimit } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url), limit = parseLimit(url);
  const scope = url.searchParams.get("scope") || "teams";
  if (scope === "teams") {
    const { results } = await env.DB.prepare(`
      SELECT t.id,t.name,t.tag,
        COUNT(m.id) AS matches_played,
        SUM(CASE WHEN m.winner_team_id=t.id THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN m.winner_team_id IS NOT NULL AND m.winner_team_id!=t.id THEN 1 ELSE 0 END) AS losses,
        ROUND(100.0*SUM(CASE WHEN m.winner_team_id=t.id THEN 1 ELSE 0 END)/NULLIF(COUNT(m.id),0),1) AS win_rate
      FROM teams t
      LEFT JOIN matches m ON (m.team_a_id=t.id OR m.team_b_id=t.id)
        AND m.status='completed' AND m.result_verified_at IS NOT NULL
      WHERE t.status='active'
      GROUP BY t.id
      ORDER BY wins DESC,win_rate DESC,matches_played DESC,t.name COLLATE NOCASE
      LIMIT ?
    `).bind(limit).all();
    return json({ data: results || [], meta: { scope, limit, basis: "verified_completed_matches" } });
  }
  if (scope === "players") {
    const { results } = await env.DB.prepare("SELECT id,nickname,role,team_id,avatar_url,region FROM players WHERE profile_status='approved' ORDER BY nickname COLLATE NOCASE LIMIT ?").bind(limit).all();
    return json({ data: results || [], meta: { scope, limit, note: "Индивидуальные очки будут рассчитаны после накопления подтверждённой игровой статистики." } });
  }
  return json({ error: { code: "INVALID_SCOPE", message: "scope должен быть teams или players." } }, 400);
}
