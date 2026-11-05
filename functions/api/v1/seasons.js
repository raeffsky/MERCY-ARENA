import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const seasonId = url.searchParams.get("id");
  if (seasonId) {
    const season = await env.DB.prepare(`
      SELECT s.id,s.title,s.season_number,s.starts_at,s.ends_at,s.status,s.image_url,s.created_at,
        (SELECT COUNT(*) FROM tournaments t WHERE t.season_id=s.id AND t.published_at IS NOT NULL AND t.status!='draft') AS tournaments_count,
        (SELECT COUNT(*) FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE t.season_id=s.id) AS matches_count,
        (SELECT COUNT(*) FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE t.season_id=s.id AND m.status='completed' AND m.result_verified_at IS NOT NULL) AS verified_matches_count
      FROM seasons s WHERE s.id=? AND s.status!='draft' LIMIT 1
    `).bind(seasonId).first();
    return json({ data: season ? [season] : [], limit: 1 });
  }
  const limit = parseLimit(url);
  const { results } = await env.DB.prepare(`
    SELECT s.id,s.season_number,s.title,s.starts_at,s.ends_at,s.status,s.image_url,s.created_at,
      (SELECT COUNT(*) FROM tournaments t WHERE t.season_id=s.id AND t.published_at IS NOT NULL AND t.status!='draft') AS tournaments_count
    FROM seasons s
    WHERE s.status != 'draft'
    ORDER BY season_number DESC, starts_at DESC
    LIMIT ?
  `).bind(limit).all();
  return json(publicList(results || [], limit));
}
