import { json, databaseUnavailable } from "../_lib/http.js";
import { getSessionUser, sameOrigin } from "../_lib/session-auth.js";
import { createAuditEventId } from "../_lib/audit.js";
import { buildCircuitRanking } from "../_lib/circuit-scoring.mjs";

function fail(code, message, status = 400) {
  return json({ error: { code, message } }, status);
}

async function getRanking(db, seasonId) {
  const { results } = await db.prepare(`
    SELECT t.id AS team_id,t.name AS team_name,t.tag AS team_tag,
      COALESCE((SELECT SUM(tx.points_delta) FROM circuit_point_transactions tx WHERE tx.team_id=t.id AND tx.season_id=?),0) AS points,
      (SELECT COUNT(*) FROM circuit_tournament_results r WHERE r.team_id=t.id AND r.season_id=? AND r.is_qualifier=0) AS tournaments_played,
      (SELECT COUNT(*) FROM circuit_tournament_results r WHERE r.team_id=t.id AND r.season_id=? AND r.is_qualifier=0 AND r.placement=1) AS first_places,
      (SELECT COUNT(*) FROM circuit_tournament_results r WHERE r.team_id=t.id AND r.season_id=? AND r.is_qualifier=0 AND r.placement=2) AS second_places,
      (SELECT COUNT(*) FROM circuit_tournament_results r WHERE r.team_id=t.id AND r.season_id=? AND r.is_qualifier=0 AND r.placement<=4) AS top_four_finishes,
      (SELECT COUNT(*) FROM matches m JOIN tournaments mt ON mt.id=m.tournament_id
        WHERE mt.season_id=? AND m.status='completed' AND m.result_verified_at IS NOT NULL AND m.winner_team_id=t.id AND NOT EXISTS (SELECT 1 FROM circuit_qualifiers cq WHERE cq.tournament_id=m.tournament_id)) AS verified_wins
    FROM teams t
    WHERE (EXISTS (SELECT 1 FROM circuit_point_transactions tx WHERE tx.team_id=t.id AND tx.season_id=?)
        OR EXISTS (SELECT 1 FROM circuit_tournament_results r WHERE r.team_id=t.id AND r.season_id=? AND r.is_qualifier=0))
  `).bind(seasonId,seasonId,seasonId,seasonId,seasonId,seasonId,seasonId,seasonId).all();
  const { results: matches } = await db.prepare(
    "SELECT m.team_a_id,m.team_b_id,m.winner_team_id FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE t.season_id=? AND m.status='completed' AND m.result_verified_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM circuit_qualifiers cq WHERE cq.tournament_id=m.tournament_id)"
  ).bind(seasonId).all();
  return buildCircuitRanking(results || [], matches || []);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return fail("ORIGIN_REJECTED", "Запрос отклонён.", 403);
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user || !auth.user.roles.includes("administrator")) return fail("FORBIDDEN", "Требуются права администратора.", 403);

  let body;
  try { body = await request.json(); } catch { return fail("INVALID_JSON", "Некорректный JSON."); }
  const action = String(body?.action || "");
  const seasonId = String(body?.season_id || "").trim();
  if (!seasonId) return fail("SEASON_REQUIRED", "Укажи ID сезона.");

  try {
    const season = await env.DB.prepare("SELECT id,title,status FROM seasons WHERE id=? LIMIT 1").bind(seasonId).first();
    if (!season) return fail("SEASON_NOT_FOUND", "Сезон не найден.", 404);

    if (action === "set_scoring_rules") {
      const rawRules = Array.isArray(body.rules) ? body.rules : [];
      if (!rawRules.length || rawRules.length > 12) return fail("INVALID_SCORING_RULES", "Укажи от одной до двенадцати ступеней начисления.");
      const rules = rawRules.map((rule) => ({
        place_from: Number(rule.place_from),
        place_to: Number(rule.place_to),
        points: Number(rule.points)
      })).sort((a,b)=>a.place_from-b.place_from);
      let expectedPlace = 1;
      for (const rule of rules) {
        if (!Number.isSafeInteger(rule.place_from) || !Number.isSafeInteger(rule.place_to) ||
            !Number.isSafeInteger(rule.points) || rule.place_from !== expectedPlace ||
            rule.place_to < rule.place_from || rule.points < 0) {
          return fail("INVALID_SCORING_RULES", "Диапазоны мест должны идти подряд без пересечений, очки должны быть целыми числами от нуля.");
        }
        expectedPlace = rule.place_to + 1;
      }
      if (rules[rules.length-1].place_to !== 2147483647) {
        return fail("INCOMPLETE_SCORING_RULES", "Последний диапазон должен покрывать все оставшиеся места.");
      }
      const existingResults = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM circuit_tournament_results WHERE season_id=? AND is_qualifier=0"
      ).bind(seasonId).first();
      if (Number(existingResults?.total || 0) > 0) return fail("SCORING_ALREADY_USED", "Нельзя менять шкалу после начисления первых очков сезона.",409);
      const statements = [env.DB.prepare("DELETE FROM circuit_scoring_rules WHERE season_id=?").bind(seasonId)];
      for (const rule of rules) {
        statements.push(env.DB.prepare(
          "INSERT INTO circuit_scoring_rules (season_id,place_from,place_to,points) VALUES (?,?,?,?)"
        ).bind(seasonId,rule.place_from,rule.place_to,rule.points));
      }
      statements.push(env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?, 'circuit_scoring_rules_updated','season',?,?)")
        .bind(await createAuditEventId(env.DB),auth.user.id,seasonId,JSON.stringify(rules)));
      await env.DB.batch(statements);
      return json({ data: { season_id: seasonId, rules } });
    }

    if (action === "register_qualifier") {
      const qualifierNumber = Number(body.qualifier_number);
      const tournamentId = String(body.tournament_id || "").trim();
      if (![1,2].includes(qualifierNumber) || !tournamentId) return fail("INVALID_QUALIFIER", "Укажи номер квалификации 1 или 2 и ID турнира.");
      const tournament = await env.DB.prepare("SELECT id,season_id,status FROM tournaments WHERE id=? LIMIT 1").bind(tournamentId).first();
      if (!tournament || String(tournament.season_id) !== seasonId) return fail("TOURNAMENT_SEASON_MISMATCH", "Турнир не найден или относится к другому сезону.", 409);
      if (tournament.status === "completed" || tournament.status === "cancelled") return fail("TOURNAMENT_CLOSED", "Нельзя подключить завершённый или отменённый турнир.", 409);
      const existingEntries = await env.DB.prepare("SELECT COUNT(*) AS total FROM circuit_championship_entries WHERE season_id=?").bind(seasonId).first();
      if (Number(existingEntries?.total || 0) > 0) return fail("QUALIFICATION_LOCKED", "Состав чемпионата уже начал фиксироваться.", 409);
      const now = new Date().toISOString();
      const inserted = await env.DB.prepare(
        "INSERT INTO circuit_qualifiers (season_id,tournament_id,qualifier_number,status,created_at) VALUES (?,?,?,'open',?)"
      ).bind(seasonId,tournamentId,qualifierNumber,now).run();
      await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?, 'circuit_qualifier_registered','season',?,?)")
        .bind(await createAuditEventId(env.DB),auth.user.id,seasonId,JSON.stringify({qualifier_number:qualifierNumber,tournament_id:tournamentId})).run();
      return json({ data: { id: inserted.meta?.last_row_id, season_id: seasonId, tournament_id: tournamentId, qualifier_number: qualifierNumber, status: "open" } },201);
    }

    if (action === "lock_ranking") {
      if (season.status !== "active" && season.status !== "completed") return fail("SEASON_NOT_READY", "Зафиксировать рейтинг можно только активного или завершённого сезона.",409);
      const existing = await env.DB.prepare("SELECT COUNT(*) AS total FROM circuit_championship_entries WHERE season_id=?").bind(seasonId).first();
      if (Number(existing?.total || 0) > 0) return fail("RANKING_ALREADY_LOCKED", "Квалификационный состав уже начал фиксироваться.",409);
      const configuredQualifiers = await env.DB.prepare("SELECT COUNT(*) AS total FROM circuit_qualifiers WHERE season_id=? AND status IN ('open','completed')").bind(seasonId).first();
      if (Number(configuredQualifiers?.total || 0) !== 2) return fail("QUALIFIERS_NOT_CONFIGURED", "Сначала подключи оба квалификационных турнира: Qualifier 1 и Qualifier 2.",409);
      const ranking = await getRanking(env.DB,seasonId);
      if (ranking.length < 6) return fail("NOT_ENOUGH_RANKED_TEAMS", "Для фиксации шести мест нужны минимум шесть команд с начисленными очками.",409);
      const now = new Date().toISOString();
      const statements = ranking.slice(0,6).map((team,index)=>env.DB.prepare(
        "INSERT INTO circuit_championship_entries (season_id,team_id,qualification_source,source_id,seed,status,qualified_at) VALUES (?,?, 'ranking', ?, ?, 'qualified', ?)"
      ).bind(seasonId,team.team_id,seasonId,index+1,now));
      statements.push(env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?, 'circuit_ranking_locked','season',?,?)")
        .bind(await createAuditEventId(env.DB),auth.user.id,seasonId,JSON.stringify({top_six:ranking.slice(0,6).map((team,index)=>({team_id:team.team_id,seed:index+1,points:team.points}))})));
      await env.DB.batch(statements);
      return json({ data: { season_id: seasonId, locked: true, entries: ranking.slice(0,6).map((team,index)=>({team_id:team.team_id,seed:index+1,points:team.points,source:"ranking"})) } });
    }

    if (action === "finalize_qualifier") {
      const qualifierId = String(body.qualifier_id || "").trim();
      if (!qualifierId) return fail("QUALIFIER_REQUIRED", "Укажи ID квалификации.");
      const qualifier = await env.DB.prepare("SELECT * FROM circuit_qualifiers WHERE id=? AND season_id=? LIMIT 1").bind(qualifierId,seasonId).first();
      if (!qualifier) return fail("QUALIFIER_NOT_FOUND", "Квалификация не найдена.",404);
      if (qualifier.status !== "open") return fail("QUALIFIER_NOT_OPEN", "Квалификация уже обработана или закрыта.",409);
      const lockedTopSix = await env.DB.prepare("SELECT COUNT(*) AS total FROM circuit_championship_entries WHERE season_id=? AND qualification_source='ranking'").bind(seasonId).first();
      if (Number(lockedTopSix?.total || 0) !== 6) return fail("RANKING_NOT_LOCKED", "Сначала зафиксируй шесть мест Circuit Ranking.",409);
      const tournament = await env.DB.prepare("SELECT status FROM tournaments WHERE id=? LIMIT 1").bind(qualifier.tournament_id).first();
      if (!tournament || tournament.status !== "completed") return fail("QUALIFIER_TOURNAMENT_NOT_COMPLETED", "Сначала полностью заверши турнир квалификации.",409);
      const { results } = await env.DB.prepare(
        "SELECT team_id,placement FROM circuit_tournament_results WHERE season_id=? AND tournament_id=? ORDER BY placement ASC"
      ).bind(seasonId,qualifier.tournament_id).all();
      const occupied = await env.DB.prepare("SELECT team_id FROM circuit_championship_entries WHERE season_id=?").bind(seasonId).all();
      const occupiedIds = new Set((occupied.results||[]).map((row)=>String(row.team_id)));
      const winner = (results||[]).find((row)=>!occupiedIds.has(String(row.team_id)));
      if (!winner) return fail("NO_ELIGIBLE_QUALIFIER_TEAM", "Нет команды, которая может занять квалификационное место.",409);
      const seed = 6 + Number(qualifier.qualifier_number);
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE circuit_qualifiers SET status='completed',winner_team_id=?,finalized_at=? WHERE id=? AND status='open'")
          .bind(winner.team_id,now,qualifierId),
        env.DB.prepare("INSERT INTO circuit_championship_entries (season_id,team_id,qualification_source,source_id,seed,status,qualified_at) VALUES (?,?, 'qualifier', ?, ?, 'qualified', ?)")
          .bind(seasonId,winner.team_id,qualifierId,seed,now),
        env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?, 'circuit_qualifier_finalized','circuit_qualifier',?,?)")
          .bind(await createAuditEventId(env.DB),auth.user.id,qualifierId,JSON.stringify({team_id:winner.team_id,placement:winner.placement,seed}))
      ]);
      return json({ data: { qualifier_id: qualifierId, team_id: winner.team_id, placement: winner.placement, seed, status: "qualified" } });
    }

    return fail("UNKNOWN_ACTION", "Неизвестное действие.");
  } catch (error) {
    console.error("MERCY CIRCUIT qualification failed:",error);
    return fail("CIRCUIT_QUALIFICATION_FAILED","Не удалось обработать квалификацию. Проверь миграцию 0018.",500);
  }
}
