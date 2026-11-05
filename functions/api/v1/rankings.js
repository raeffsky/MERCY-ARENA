import { json, databaseUnavailable, parseLimit } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url), limit = parseLimit(url);
  const scope = url.searchParams.get("scope") || "teams";
  const seasonId = url.searchParams.get("season_id") || "";
  if (scope === "teams") {
    // Apply the season constraint inside the LEFT JOIN. Filtering the joined
    // tournament in WHERE accidentally removed teams with no matches in a season.
    const seasonMatchFilter = seasonId
      ? " AND EXISTS (SELECT 1 FROM tournaments tour WHERE tour.id=m.tournament_id AND tour.season_id=?)"
      : "";
    const sql = `
      SELECT t.id,t.name,t.tag,
        COUNT(m.id) AS matches_played,
        COALESCE(SUM(CASE WHEN m.winner_team_id=t.id THEN 1 ELSE 0 END),0) AS wins,
        COALESCE(SUM(CASE WHEN m.winner_team_id IS NOT NULL AND m.winner_team_id!=t.id THEN 1 ELSE 0 END),0) AS losses,
        COALESCE(SUM(CASE WHEN m.winner_team_id=t.id THEN 3 ELSE 0 END),0) AS points,
        COALESCE(ROUND(100.0*SUM(CASE WHEN m.winner_team_id=t.id THEN 1 ELSE 0 END)/NULLIF(COUNT(m.id),0),1),0) AS win_rate
      FROM teams t
      LEFT JOIN matches m ON (m.team_a_id=t.id OR m.team_b_id=t.id)
        AND m.status='completed' AND m.result_verified_at IS NOT NULL ${seasonMatchFilter}
      WHERE t.status='active'
      GROUP BY t.id
      ORDER BY points DESC,wins DESC,win_rate DESC,matches_played DESC,t.name COLLATE NOCASE
      LIMIT ?
    `;
    const values = seasonId ? [seasonId, limit] : [limit];
    const { results } = await env.DB.prepare(sql).bind(...values).all();
    return json({ data: results || [], meta: { scope, limit, season_id: seasonId || null, scoring: "3 points per verified win; losses 0" } });
  }
  if (scope === "players") {
    const seasonFilter = seasonId ? " AND tour.season_id=?" : "";
    try {
      const { results } = await env.DB.prepare(`
        WITH player_matches AS (
          SELECT DISTINCT p.id AS player_id,m.id AS match_id,m.winner_team_id,r.team_id
          FROM tournament_registration_roster rr
          JOIN players p ON p.id=rr.player_id
          JOIN tournament_registrations r ON r.id=rr.registration_id AND r.status='approved'
          JOIN matches m ON m.tournament_id=r.tournament_id
            AND (m.team_a_id=r.team_id OR m.team_b_id=r.team_id)
            AND m.status='completed' AND m.result_verified_at IS NOT NULL
          JOIN tournaments tour ON tour.id=m.tournament_id
          WHERE rr.roster_role='starter' ${seasonFilter}
        )
        SELECT p.id,p.nickname,p.role,p.team_id,p.avatar_url,p.region,
          COUNT(pm.match_id) AS matches_played,
          COALESCE(SUM(CASE WHEN pm.winner_team_id=pm.team_id THEN 1 ELSE 0 END),0) AS wins,
          COALESCE(SUM(CASE WHEN pm.winner_team_id IS NOT NULL AND pm.winner_team_id!=pm.team_id THEN 1 ELSE 0 END),0) AS losses,
          COALESCE(SUM(CASE WHEN pm.winner_team_id=pm.team_id THEN 3 ELSE 0 END),0) AS points,
          COALESCE(ROUND(100.0*SUM(CASE WHEN pm.winner_team_id=pm.team_id THEN 1 ELSE 0 END)/NULLIF(COUNT(pm.match_id),0),1),0) AS win_rate
        FROM players p
        LEFT JOIN player_matches pm ON pm.player_id=p.id
        WHERE p.profile_status='approved'
        GROUP BY p.id
        ORDER BY points DESC,wins DESC,win_rate DESC,matches_played DESC,p.nickname COLLATE NOCASE
        LIMIT ?
      `).bind(...(seasonId ? [seasonId, limit] : [limit])).all();
      return json({ data: results || [], meta: { scope, limit, season_id: seasonId || null, scoring: "3 points per verified win; only registered starting players count" } });
    } catch (error) {
      if (!/no such table:\s*tournament_registration_roster/i.test(String(error?.message || error))) throw error;
      console.warn("Player rankings are unavailable until migration 0013 is applied.");
      const { results } = await env.DB.prepare(`
        SELECT id,nickname,role,team_id,avatar_url,region,
          0 AS matches_played,0 AS wins,0 AS losses,0 AS points,0 AS win_rate
        FROM players
        WHERE profile_status='approved'
        ORDER BY nickname COLLATE NOCASE
        LIMIT ?
      `).bind(limit).all();
      return json({ data: results || [], meta: { scope, limit, season_id: seasonId || null, scoring: "3 points per verified win; statistics awaiting roster migration" } });
    }
  }
  return json({ error: { code: "INVALID_SCOPE", message: "scope должен быть teams или players." } }, 400);
}
