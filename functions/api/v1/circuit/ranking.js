import { json, databaseUnavailable } from "../_lib/http.js";
import { buildCircuitRanking } from "../_lib/circuit-scoring.mjs";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const seasonId = String(url.searchParams.get("season_id") || "").trim();
  if (!seasonId) {
    return json({ error: { code: "SEASON_REQUIRED", message: "Укажи ID сезона MERCY CIRCUIT." } }, 400);
  }

  try {
    const season = await env.DB.prepare(
      "SELECT id,title,season_number,starts_at,ends_at,status FROM seasons WHERE id=? LIMIT 1"
    ).bind(seasonId).first();
    if (!season) return json({ error: { code: "SEASON_NOT_FOUND", message: "Сезон не найден." } }, 404);

    const { results } = await env.DB.prepare(`
      SELECT t.id AS team_id,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo,
        COALESCE((SELECT SUM(tx.points_delta) FROM circuit_point_transactions tx
          WHERE tx.team_id=t.id AND tx.season_id=?),0) AS points,
        (SELECT COUNT(*) FROM circuit_tournament_results r
          WHERE r.team_id=t.id AND r.season_id=?) AS tournaments_played,
        (SELECT COUNT(*) FROM circuit_tournament_results r
          WHERE r.team_id=t.id AND r.season_id=? AND r.placement=1) AS first_places,
        (SELECT COUNT(*) FROM circuit_tournament_results r
          WHERE r.team_id=t.id AND r.season_id=? AND r.placement=2) AS second_places,
        (SELECT COUNT(*) FROM circuit_tournament_results r
          WHERE r.team_id=t.id AND r.season_id=? AND r.placement<=4) AS top_four_finishes,
        (SELECT COUNT(*) FROM matches m JOIN tournaments mt ON mt.id=m.tournament_id
          WHERE mt.season_id=? AND m.status='completed' AND m.result_verified_at IS NOT NULL
          AND m.winner_team_id=t.id) AS verified_wins
      FROM teams t
      WHERE t.status='active'
        AND (EXISTS (SELECT 1 FROM circuit_point_transactions tx WHERE tx.team_id=t.id AND tx.season_id=?)
          OR EXISTS (SELECT 1 FROM circuit_tournament_results r WHERE r.team_id=t.id AND r.season_id=?))
    `).bind(seasonId,seasonId,seasonId,seasonId,seasonId,seasonId,seasonId,seasonId).all();

    const { results: rankingMatches } = await env.DB.prepare(
      "SELECT m.team_a_id,m.team_b_id,m.winner_team_id FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE t.season_id=? AND m.status='completed' AND m.result_verified_at IS NOT NULL"
    ).bind(seasonId).all();
    const ranking = buildCircuitRanking(results || [], rankingMatches || []);
    const { results: entries } = await env.DB.prepare(
      "SELECT team_id,qualification_source,source_id,seed,status FROM circuit_championship_entries WHERE season_id=? ORDER BY seed"
    ).bind(seasonId).all();
    const { results: qualifiers } = await env.DB.prepare(
      "SELECT id,tournament_id,qualifier_number,status,winner_team_id,finalized_at FROM circuit_qualifiers WHERE season_id=? ORDER BY qualifier_number"
    ).bind(seasonId).all();

    return json({
      data: ranking,
      season,
      qualifiers: qualifiers || [],
      championship: (entries || []).map((entry) => ({
        ...entry,
        team: ranking.find((team) => String(team.team_id) === String(entry.team_id)) || null
      })),
      meta: { scoring: "placement", season_reset: true, qualification_slots: "6+2", ranking_scope: "teams" }
    });
  } catch (error) {
    console.error("MERCY CIRCUIT ranking failed:", error);
    return json({ error: { code: "CIRCUIT_RANKING_FAILED", message: "Не удалось загрузить рейтинг MERCY CIRCUIT. Проверь миграцию 0018." } }, 500);
  }
}
