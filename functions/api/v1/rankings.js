import { json, databaseUnavailable, parseLimit } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const scope = url.searchParams.get("scope") || "teams";
  if (scope === "teams") {
    const { results } = await env.DB.prepare(`SELECT t.id,t.name,t.tag,COUNT(m.id) AS matches_played,SUM(CASE WHEN m.winner_team_id = t.id THEN 1 ELSE 0 END) AS wins FROM teams t LEFT JOIN matches m ON (m.team_a_id = t.id OR m.team_b_id = t.id) AND m.status = 'confirmed' GROUP BY t.id ORDER BY wins DESC,matches_played DESC,t.name COLLATE NOCASE LIMIT ?`).bind(limit).all();
    return json({ data: results || [], meta: { scope, limit } });
  }
  if (scope === "players") {
    const { results } = await env.DB.prepare("SELECT id,nickname,role,team_id FROM players ORDER BY nickname COLLATE NOCASE LIMIT ?").bind(limit).all();
    return json({ data: results || [], meta: { scope, limit, note: "Индивидуальные очки будут рассчитываться после утверждения рейтинговой модели." } });
  }
  return json({ error: { code: "INVALID_SCOPE", message: "scope должен быть teams или players." } }, 400);
}
