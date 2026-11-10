import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";
import { createAuditEventId } from "./_lib/audit.js";

function fail(code, message, status = 400) {
  return json({ error: { code, message } }, status);
}

export async function onRequestGet({ env }) {
  if (!env.DB) return databaseUnavailable();
  try {
    const current = await env.DB.prepare(
      "SELECT r.id,r.team_id,r.started_at,r.defenses_count,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo,t.region AS team_region FROM mercy_crown_reigns r JOIN teams t ON t.id=r.team_id WHERE r.ended_at IS NULL LIMIT 1"
    ).first();
    const { results: history } = await env.DB.prepare(
      "SELECT r.id,r.team_id,r.started_at,r.ended_at,r.defenses_count,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo FROM mercy_crown_reigns r JOIN teams t ON t.id=r.team_id ORDER BY r.started_at DESC,r.id DESC LIMIT 50"
    ).all();
    const { results: challenges } = await env.DB.prepare(
      "SELECT c.id,c.reign_id,c.champion_team_id,c.challenger_team_id,c.match_id,c.status,c.winner_team_id,c.created_at,c.decided_at,champion.name AS champion_name,challenger.name AS challenger_name,winner.name AS winner_name,m.scheduled_at,m.score_a,m.score_b FROM mercy_crown_challenges c JOIN teams champion ON champion.id=c.champion_team_id JOIN teams challenger ON challenger.id=c.challenger_team_id LEFT JOIN teams winner ON winner.id=c.winner_team_id JOIN matches m ON m.id=c.match_id ORDER BY c.created_at DESC,c.id DESC LIMIT 50"
    ).all();
    return json({ current: current || null, history: history || [], challenges: challenges || [] });
  } catch (error) {
    console.error("MERCY CROWN lookup failed:", error);
    return fail("CROWN_UNAVAILABLE", "MERCY CROWN пока не настроена. Проверь миграцию 0021.", 503);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return fail("ORIGIN_REJECTED", "Запрос отклонён.", 403);
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user || !auth.user.roles.includes("administrator") || !isOwnerAccount(auth.user, env)) {
    return fail("FORBIDDEN", "Управлять MERCY CROWN может только владелец платформы.", 403);
  }
  let body;
  try { body = await request.json(); } catch { return fail("INVALID_JSON", "Некорректный JSON."); }
  const action = String(body.action || "");
  const now = new Date().toISOString();

  try {
    if (action === "appoint_champion") {
      const teamId = String(body.team_id || "").trim();
      if (!/^\d+$/.test(teamId)) return fail("INVALID_TEAM", "Укажи корректную команду.");
      const team = await env.DB.prepare("SELECT id FROM teams WHERE id=? AND status='active' AND archived_at IS NULL").bind(teamId).first();
      if (!team) return fail("TEAM_NOT_ELIGIBLE", "Команда не найдена или неактивна.", 409);
      const active = await env.DB.prepare("SELECT id FROM mercy_crown_reigns WHERE ended_at IS NULL LIMIT 1").first();
      if (active) return fail("CROWN_ALREADY_HELD", "У короны уже есть действующий чемпион. Новый чемпион определяется только через защиту.", 409);
      const result = await env.DB.prepare("INSERT INTO mercy_crown_reigns (team_id,started_at,created_by) VALUES (?,?,?)").bind(teamId,now,auth.user.id).run();
      const reignId = result.meta?.last_row_id;
      await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'mercy_crown_champion_appointed','mercy_crown_reign',?,?)")
        .bind(await createAuditEventId(env.DB),auth.user.id,reignId,JSON.stringify({team_id:teamId})).run();
      return json({ data: { reign_id: reignId, team_id: teamId, started_at: now, defenses_count: 0 } },201);
    }

    if (action === "schedule_challenge") {
      const challengerId = String(body.challenger_team_id || "").trim();
      const matchId = String(body.match_id || "").trim();
      if (!/^\d+$/.test(challengerId) || !/^\d+$/.test(matchId)) return fail("INVALID_CHALLENGE", "Укажи команду-претендента и матч.");
      const reign = await env.DB.prepare("SELECT id,team_id FROM mercy_crown_reigns WHERE ended_at IS NULL LIMIT 1").first();
      if (!reign) return fail("CROWN_UNCLAIMED", "Сначала назначь первого чемпиона.",409);
      const champion = await env.DB.prepare("SELECT id FROM teams WHERE id=? AND status='active' AND archived_at IS NULL").bind(reign.team_id).first();
      if (!champion) return fail("CROWN_CHAMPION_INACTIVE", "Действующий чемпион неактивен или архивирован. Сначала восстанови команду.",409);
      if (String(reign.team_id) === challengerId) return fail("INVALID_CHALLENGER", "Действующий чемпион не может бросить вызов сам себе.",409);
      const challenger = await env.DB.prepare("SELECT id FROM teams WHERE id=? AND status='active' AND archived_at IS NULL").bind(challengerId).first();
      if (!challenger) return fail("INVALID_CHALLENGER", "Команда-претендент должна быть активной и неархивной.",409);
      const match = await env.DB.prepare("SELECT m.id,m.tournament_id,m.status,m.team_a_id,m.team_b_id,m.scheduled_at,t.status AS tournament_status,t.published_at AS tournament_published_at FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=?").bind(matchId).first();
      if (!match || !match.tournament_published_at || !["published","active"].includes(match.tournament_status) || !["scheduled","in_progress"].includes(match.status) ||
          new Set([String(match.team_a_id),String(match.team_b_id)]).size !== 2 ||
          ![String(reign.team_id),challengerId].every(id => [String(match.team_a_id),String(match.team_b_id)].includes(id))) {
        return fail("MATCH_NOT_ELIGIBLE", "Матч должен быть запланирован между действующим чемпионом и выбранным претендентом.",409);
      }
      const result = await env.DB.prepare("INSERT INTO mercy_crown_challenges (reign_id,champion_team_id,challenger_team_id,match_id,status,created_by,created_at) VALUES (?,?,?,?,'scheduled',?,?)")
        .bind(reign.id,reign.team_id,challengerId,matchId,auth.user.id,now).run();
      const id = result.meta?.last_row_id;
      await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'mercy_crown_challenge_scheduled','mercy_crown_challenge',?,?)")
        .bind(await createAuditEventId(env.DB),auth.user.id,id,JSON.stringify({reign_id:reign.id,champion_team_id:reign.team_id,challenger_team_id:challengerId,match_id:matchId})).run();
      return json({ data: { id, status: "scheduled", match_id: matchId } },201);
    }

    if (action === "resolve_challenge") {
      const challengeId = String(body.challenge_id || "").trim();
      if (!/^\d+$/.test(challengeId)) return fail("INVALID_CHALLENGE", "Укажи ID защиты.");
      const challenge = await env.DB.prepare("SELECT c.*,r.ended_at AS reign_ended_at FROM mercy_crown_challenges c JOIN mercy_crown_reigns r ON r.id=c.reign_id WHERE c.id=?").bind(challengeId).first();
      if (!challenge || challenge.status !== "scheduled" || challenge.reign_ended_at !== null) return fail("CHALLENGE_NOT_OPEN", "Защита не найдена или уже обработана.",409);
      const match = await env.DB.prepare("SELECT status,team_a_id,team_b_id,winner_team_id,result_verified_at FROM matches WHERE id=?").bind(challenge.match_id).first();
      if (!match || match.status !== "completed" || !match.result_verified_at || !match.winner_team_id) {
        return fail("MATCH_NOT_VERIFIED", "Результат матча должен быть завершён и подтверждён судьёй.",409);
      }
      if (![String(challenge.champion_team_id),String(challenge.challenger_team_id)].every(id => [String(match.team_a_id),String(match.team_b_id)].includes(id))) {
        return fail("MATCH_TEAMS_CHANGED", "Состав участников матча изменился после назначения защиты.",409);
      }
      const winnerId = String(match.winner_team_id);
      if (![String(challenge.champion_team_id),String(challenge.challenger_team_id)].includes(winnerId)) return fail("INVALID_MATCH_WINNER", "Победитель матча не совпадает с участниками защиты.",409);
      // The extra fractional digits form a per-request compare-and-set token.
      // Every write after the status transition is guarded by this exact decision.
      const operationNow = now.replace(/(\.\d{3})Z$/, function(_, milliseconds) {
        return milliseconds + String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0") + "Z";
      });
      const decisionGuard = "EXISTS (SELECT 1 FROM mercy_crown_challenges WHERE id=? AND status='decided' AND decided_at=? AND winner_team_id=? AND reign_id=?)";
      const statements = [
        env.DB.prepare("UPDATE mercy_crown_challenges SET status='decided',winner_team_id=?,decided_at=? WHERE id=? AND status='scheduled' AND reign_id=? AND EXISTS (SELECT 1 FROM mercy_crown_reigns WHERE id=? AND ended_at IS NULL)").bind(winnerId,operationNow,challengeId,challenge.reign_id,challenge.reign_id)
      ];
      if (winnerId === String(challenge.challenger_team_id)) {
        statements.push(env.DB.prepare("UPDATE mercy_crown_reigns SET ended_at=? WHERE id=? AND ended_at IS NULL AND " + decisionGuard).bind(operationNow,challenge.reign_id,challengeId,operationNow,winnerId,challenge.reign_id));
        statements.push(env.DB.prepare("INSERT INTO mercy_crown_reigns (team_id,started_at,created_by) SELECT ?,?,? WHERE " + decisionGuard + " AND EXISTS (SELECT 1 FROM mercy_crown_reigns WHERE id=? AND ended_at=?)").bind(winnerId,operationNow,auth.user.id,challengeId,operationNow,winnerId,challenge.reign_id,challenge.reign_id,operationNow));
      } else {
        statements.push(env.DB.prepare("UPDATE mercy_crown_reigns SET defenses_count=defenses_count+1 WHERE id=? AND ended_at IS NULL AND " + decisionGuard).bind(challenge.reign_id,challengeId,operationNow,winnerId,challenge.reign_id));
      }
      statements.push(env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) SELECT ?,?,'mercy_crown_challenge_resolved','mercy_crown_challenge',?,? WHERE " + decisionGuard)
        .bind(await createAuditEventId(env.DB),auth.user.id,challengeId,JSON.stringify({winner_team_id:winnerId,previous_champion_id:challenge.champion_team_id,challenger_team_id:challenge.challenger_team_id}),challengeId,operationNow,winnerId,challenge.reign_id));
      const writes = await env.DB.batch(statements);
      if (!writes[0]?.meta?.changes) return fail("CHALLENGE_NOT_OPEN", "Защита уже обработана или корона сменила владельца.",409);
      if (!writes[1]?.meta?.changes || (winnerId === String(challenge.challenger_team_id) && !writes[2]?.meta?.changes)) {
        console.error("MERCY CROWN transition was not completed atomically", writes.map(item => item?.meta?.changes));
        return fail("CROWN_TRANSITION_FAILED", "Не удалось завершить переход чемпионского титула.",500);
      }
      return json({ data: { challenge_id: challengeId, winner_team_id: winnerId, title_changed: winnerId === String(challenge.challenger_team_id), decided_at: operationNow } });
    }

    return fail("UNKNOWN_ACTION", "Неизвестное действие.");
  } catch (error) {
    console.error("MERCY CROWN action failed:", error);
    if (/UNIQUE constraint failed.*match_id/i.test(String(error?.message || error))) return fail("MATCH_ALREADY_LINKED", "Этот матч уже назначен защитой короны.",409);
    if (/UNIQUE constraint failed.*idx_mercy_crown_one_active_reign/i.test(String(error?.message || error))) return fail("CROWN_ALREADY_HELD", "У короны уже есть действующий чемпион.",409);
    if (/UNIQUE constraint failed.*(?:idx_mercy_crown_one_scheduled_challenge|mercy_crown_challenges\.reign_id)/i.test(String(error?.message || error))) return fail("CROWN_CHALLENGE_PENDING", "У действующего чемпиона уже назначена защита. Сначала заверши её.",409);
    return fail("CROWN_ACTION_FAILED", "Не удалось обработать действие MERCY CROWN.",500);
  }
}

export function onRequestPut() { return methodNotAllowed("POST"); }
