import { createAuditEventId } from "./_lib/audit.js";
import { json, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";
import { advanceWinner, completeTournamentIfReady, finalizeCircuitTournament, prepareFinalizedCircuitCorrection } from "./_lib/match-progression.js";
import { prepareMatchCorrectionCascade } from "./_lib/match-correction-cascade.mjs";

const TABLES = {
  tournaments: { table: "tournaments", fields: ["title","description","game","region","format","status","max_teams","registration_open_at","registration_close_at","starts_at","ends_at","rules_url","season_id","prize_pool","poster_url"] },
  teams: { table: "teams", fields: ["name","tag","logo_url","captain_id","region","status"] },
  players: { table: "players", fields: ["user_id","game_id","nickname","role","team_id","region","profile_status"] },
  matches: { table: "matches", fields: ["tournament_id","round_number","bracket","match_number","scheduled_at","status","team_a_id","team_b_id","score_a","score_b","winner_team_id"] },
  seasons: { table: "seasons", fields: ["id","title","season_number","starts_at","ends_at","status","image_url"] }
};
const FORMATS = new Set(["single_elimination","double_elimination","round_robin"]);
const STATUSES = {
  tournaments: new Set(["draft","published","active","completed","cancelled"]),
  teams: new Set(["active","inactive","dissolved"]),
  players: new Set(["pending","approved","rejected"]),
  matches: new Set(["scheduled","in_progress","completed","cancelled","postponed"]),
  seasons: new Set(["planning","active","completed","cancelled"])
};
const now = () => new Date().toISOString();

async function authorize(request, env) {
  if (!env.DB) return { response: json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных не подключена." } }, 503) };
  const session = await getSessionUser(request, env);
  if (session.error) return { response: session.error };
  if (!session.user || !session.user.roles.includes("administrator") || !isOwnerAccount(session.user, env)) {
    return { response: json({ error: { code: "FORBIDDEN", message: "Требуются права администратора." } }, 403) };
  }
  return { user: session.user };
}
function bad(message, status = 400) {
  return json({ error: { code: "INVALID_REQUEST", message } }, status);
}
function cleanValue(field, value) {
  const integerFields = new Set(["id","max_teams","round_number","match_number","score_a","score_b","season_number"]);
  const nullableFields = new Set(["description","region","logo_url","poster_url","image_url","prize_pool","captain_id","max_teams","registration_open_at","registration_close_at","starts_at","ends_at","rules_url","season_id","role","team_id","scheduled_at","team_a_id","team_b_id","score_a","score_b","winner_team_id"]);
  if (value === "" && nullableFields.has(field)) return null;
  if (integerFields.has(field)) {
    if (value === null && nullableFields.has(field)) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < (field === "id" || field === "season_number" ? 1 : 0)) throw new Error("Поле «" + field + "» должно быть положительным целым числом.");
    return n;
  }
  if (value === null && nullableFields.has(field)) return null;
  if (typeof value !== "string") throw new Error("Некорректное значение поля «" + field + "».");
  const v = value.trim();
  if (v.length > 2000) throw new Error("Слишком длинное значение поля «" + field + "».");
  return v || (nullableFields.has(field) ? null : "");
}
async function audit(db, actor, action, entity, id, before, after) {
  await db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?,?)")
    .bind(await createAuditEventId(db), actor, action, entity, String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
}
async function getById(db, table, id) {
  return db.prepare("SELECT * FROM " + table + " WHERE id=?").bind(id).first();
}

export async function onRequestGet({ request, env }) {
  try {
  const auth = await authorize(request, env);
  if (auth.response) return auth.response;
  const resource = new URL(request.url).searchParams.get("resource") || "";
  if (resource === "applications") {
    const { results } = await env.DB.prepare(`SELECT r.id,r.tournament_id,r.team_id,r.status,r.submitted_at,r.reviewed_at,r.reviewer_id,r.selected_slot,r.captain_note,t.title AS tournament_title,tm.name AS team_name,tm.tag AS team_tag,tm.captain_id,
      (SELECT COUNT(*) FROM tournament_registration_roster rr WHERE rr.registration_id=r.id AND rr.roster_role='starter') AS starters,
      (SELECT COUNT(*) FROM tournament_registration_roster rr WHERE rr.registration_id=r.id AND rr.roster_role='substitute') AS substitutes,
      (SELECT GROUP_CONCAT(p.nickname, ', ') FROM tournament_registration_roster rr JOIN players p ON p.id=rr.player_id WHERE rr.registration_id=r.id AND rr.roster_role='starter') AS starter_names,
      (SELECT GROUP_CONCAT(p.nickname, ', ') FROM tournament_registration_roster rr JOIN players p ON p.id=rr.player_id WHERE rr.registration_id=r.id AND rr.roster_role='substitute') AS substitute_names
      FROM tournament_registrations r JOIN tournaments t ON t.id=r.tournament_id JOIN teams tm ON tm.id=r.team_id
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.submitted_at DESC LIMIT 200`).all();
    return json({ data: results || [] });
  }
  if (resource === "users") {
    const { results } = await env.DB.prepare("SELECT id,email,display_name FROM users ORDER BY email COLLATE NOCASE LIMIT 200").all();
    return json({ data: results || [] });
  }
  const config = TABLES[resource];
  if (!config) return bad("Неизвестный раздел.");
  if (resource === "matches") {
    const { results } = await env.DB.prepare(
      "SELECT m.*,t.title AS tournament_title,t.status AS tournament_status,ta.name AS team_a_name,tb.name AS team_b_name " +
      "FROM matches m JOIN tournaments t ON t.id=m.tournament_id " +
      "LEFT JOIN teams ta ON ta.id=m.team_a_id LEFT JOIN teams tb ON tb.id=m.team_b_id " +
      "ORDER BY m.scheduled_at IS NULL,m.scheduled_at ASC,m.tournament_id,m.round_number,m.match_number LIMIT 200"
    ).all();
    return json({ data: results || [] });
  }
  const { results } = await env.DB.prepare("SELECT * FROM " + config.table + (resource === "seasons" ? " ORDER BY season_number DESC,id DESC" : " ORDER BY id DESC") + " LIMIT 200").all();
  return json({ data: results || [] });
  } catch (error) {
    console.error("MERCY ARENA admin GET failed:", error);
    return json({ error: { code: "ADMIN_READ_FAILED", message: "Не удалось загрузить данные. Проверьте схему базы и журнал Functions." } }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await authorize(request, env);
  if (auth.response) return auth.response;
  let body;
  try { body = await request.json(); } catch { return bad("Некорректный JSON."); }
  const { resource, action = "create", id, data = {} } = body || {};
    if (resource === "matches" && action === "correct_result") {
    const matchId = String(id ?? "").trim();
    const scoreA = Number(data.score_a);
    const scoreB = Number(data.score_b);
    if (!matchId || matchId.length > 128 ||
        !Number.isSafeInteger(scoreA) || scoreA < 0 ||
        !Number.isSafeInteger(scoreB) || scoreB < 0 || scoreA === scoreB) {
      return bad("Укажи корректный ID матча и победный счёт из целых неотрицательных чисел.");
    }
    const before = await env.DB.prepare(
      "SELECT m.*,t.status AS tournament_status,t.format AS tournament_format,t.season_id AS tournament_season_id FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=? LIMIT 1"
    ).bind(matchId).first();
    if (!before) return bad("Матч не найден.", 404);
    if (before.status !== "completed") return bad("Корректировать можно только завершённый матч.", 409);
    const finalizedTournament = before.tournament_status === "completed";
    if (before.team_a_id == null || before.team_b_id == null) return bad("У матча должны быть назначены обе команды.", 409);
    const oldWinner = String(before.winner_team_id || "");
    const teamA = String(before.team_a_id), teamB = String(before.team_b_id);
    if (![teamA, teamB].includes(oldWinner)) return bad("У сохранённого результата некорректный победитель.", 409);
    const newWinner = scoreA > scoreB ? teamA : teamB;
    const timestamp = now();
    const writes = [];
    // D1 batch is transactional. Force a constraint failure when any guarded
    // update changes zero rows so a concurrent edit cannot leave a partial branch rewrite.
    const guardSuccessfulWrite = () => writes.push(env.DB.prepare(
      "INSERT INTO audit_events (action,entity_type,entity_id) SELECT NULL,'match','0' WHERE changes()=0"
    ));

    let cascade = { statements: [], summary: { route_count: 0, updated_slots: 0, reset_matches: [] } };
    if (oldWinner !== newWinner) {
      try {
        cascade = await prepareMatchCorrectionCascade(
          env.DB, before.tournament_id, before, newWinner, timestamp
        );
      } catch (error) {
        return bad(error.message || "Не удалось безопасно пересчитать зависимые матчи.", 409);
      }
      const invalidDoubleEliminationRoutes =
        before.tournament_format === "double_elimination" &&
        ((before.bracket === "upper" &&
          (cascade.summary.route_count !== 2 ||
           !cascade.summary.route_outcomes.includes("winner") ||
           !cascade.summary.route_outcomes.includes("loser"))) ||
         (before.bracket === "lower" &&
          (cascade.summary.route_count !== 1 || cascade.summary.route_outcomes[0] !== "winner")));
      if (invalidDoubleEliminationRoutes) {
        return bad("Для этого матча не найдены маршруты Double Elimination. Корректировка остановлена, чтобы не повредить сетку.", 409);
      }
      if (finalizedTournament && before.tournament_season_id != null &&
          cascade.summary.reset_matches.length) {
        return bad("Этот Circuit-турнир уже завершён. Каскад потребует переиграть зависимые матчи и отдельно пересчитать очки сезона, поэтому автоматическая корректировка остановлена.", 409);
      }
      writes.push(...cascade.statements);
    }
    const reopenedTournament = finalizedTournament && cascade.summary.reset_matches.length > 0;
    if (reopenedTournament) {
      writes.push(env.DB.prepare(
        "UPDATE tournaments SET status='active',updated_at=? WHERE id=? AND status='completed'"
      ).bind(timestamp,before.tournament_id));
      guardSuccessfulWrite();
    }

    // Grand Final reset is conditional: the lower-bracket finalist must win
    // the first final to activate the second match.
    if (before.bracket === "final" && Number(before.round_number) === 1 && oldWinner !== newWinner) {
      const reset = await env.DB.prepare(
        "SELECT id,status,team_a_id,team_b_id,score_a,score_b,winner_team_id FROM matches WHERE tournament_id=? AND bracket='final' AND round_number=2 LIMIT 1"
      ).bind(before.tournament_id).first();
      if (reset) {
        if (finalizedTournament) {
          return bad("Первый Grand Final завершённого Double Elimination нельзя менять отдельно от Reset Final. Для этого нужна каскадная корректировка всей финальной серии.", 409);
        }
        if (reset.status === "completed" || reset.status === "in_progress" ||
            reset.score_a != null || reset.score_b != null || reset.winner_team_id != null) {
          return bad("Reset Final уже начат или завершён. Его результат нельзя затронуть корректировкой первого финала.", 409);
        }
        if (newWinner === teamB && reset.status === "cancelled") {
          writes.push(env.DB.prepare(
            "UPDATE matches SET team_a_id=?,team_b_id=?,status='scheduled',updated_at=? WHERE id=? AND status='cancelled'"
          ).bind(before.team_a_id,before.team_b_id,timestamp,reset.id));
          guardSuccessfulWrite();
        } else if (newWinner === teamA && reset.status === "scheduled") {
          if (String(reset.team_a_id ?? "") !== teamA || String(reset.team_b_id ?? "") !== teamB) {
            return bad("У Reset Final изменились участники. Корректировка остановлена.", 409);
          }
          writes.push(env.DB.prepare(
            "UPDATE matches SET team_a_id=NULL,team_b_id=NULL,status='cancelled',updated_at=? WHERE id=? AND status='scheduled' AND team_a_id=? AND team_b_id=?"
          ).bind(timestamp,reset.id,before.team_a_id,before.team_b_id));
          guardSuccessfulWrite();
        } else if (newWinner === teamA && reset.status !== "cancelled") {
          return bad("Состояние Reset Final не соответствует первому финалу. Корректировка остановлена.", 409);
        } else if (newWinner === teamB && reset.status !== "scheduled") {
          return bad("Нельзя безопасно активировать Reset Final в текущем состоянии.", 409);
        }
      }
    }

    writes.push(env.DB.prepare(
      "UPDATE matches SET score_a=?,score_b=?,winner_team_id=?,result_source='admin_correction',result_verified_at=?,updated_at=? WHERE id=? AND status='completed' AND score_a=? AND score_b=? AND winner_team_id=?"
    ).bind(scoreA,scoreB,newWinner,timestamp,timestamp,matchId,before.score_a,before.score_b,before.winner_team_id));
    guardSuccessfulWrite();
    writes.push(env.DB.prepare(
      "UPDATE result_events SET validation_status='reviewed',decision_reason=?,reviewed_at=? WHERE match_id=? AND validation_status='valid'"
    ).bind("Superseded by manual result correction",timestamp,matchId));
    let circuitReconciliation = null;
    if (finalizedTournament && before.tournament_season_id != null) {
      try {
        const prepared = await prepareFinalizedCircuitCorrection(
          env.DB, before.tournament_id, auth.user.id, matchId,
          { score_a: scoreA, score_b: scoreB, winner_team_id: newWinner }
        );
        writes.push(...prepared.statements);
        circuitReconciliation = prepared.summary;
      } catch (error) {
        return bad(error.message || "Не удалось безопасно пересчитать MERCY CIRCUIT.", 409);
      }
    }
    writes.push(env.DB.prepare(
      "INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?, 'match_result_corrected','matches',?,?,?)"
    ).bind(await createAuditEventId(env.DB),auth.user.id,String(matchId),
      JSON.stringify({score_a:before.score_a,score_b:before.score_b,winner_team_id:before.winner_team_id}),
      JSON.stringify({score_a:scoreA,score_b:scoreB,winner_team_id:newWinner,downstream_updates:cascade.summary.updated_slots,cascade_reset_matches:cascade.summary.reset_matches,tournament_id:before.tournament_id})));
    try {
      await env.DB.batch(writes);
    } catch (error) {
      if (/NOT NULL constraint failed: audit_events.action/i.test(String(error?.message || error))) {
        return bad("Матч или связанные слоты изменились параллельно. Ничего не сохранено, обнови данные и повтори корректировку.", 409);
      }
      throw error;
    }
    const after = await getById(env.DB, "matches", matchId);
    const tournamentCompleted = reopenedTournament ? false : finalizedTournament ? true : await completeTournamentIfReady(env.DB, before.tournament_id);
    return json({
      data: after,
      corrected: true,
      downstream_updates: cascade.summary.updated_slots,
      cascade_reset_matches: cascade.summary.reset_matches,
      tournament_completed: tournamentCompleted,
      circuit_reconciliation: circuitReconciliation
    });
  }
  if (resource === "players" && action === "purge_demo") {
    const { results = [] } = await env.DB.prepare(
      "SELECT p.id,p.nickname,p.game_id FROM players p WHERE UPPER(p.nickname) LIKE 'DEMO %' AND UPPER(p.game_id) LIKE 'DEMO-%' ORDER BY p.id"
    ).all();
    if (!results.length) return json({ ok: true, deleted: 0, message: "Демо-игроки не найдены." });
    const ids = results.map(player => player.id);
    const placeholders = ids.map(() => "?").join(",");
    const { results: used = [] } = await env.DB.prepare(
      "SELECT DISTINCT player_id FROM tournament_registration_roster WHERE player_id IN (" + placeholders + ")"
    ).bind(...ids).all();
    const usedIds = new Set(used.map(row => String(row.player_id)));
    const blocked = results.filter(player => usedIds.has(String(player.id)));
    if (blocked.length) {
      return json({ error: { code: "DEMO_PLAYERS_IN_HISTORY", message: "Некоторые демо-профили уже входят в историю заявок. Удаление остановлено, чтобы не повредить историю.", players: blocked.map(player => ({id:player.id,nickname:player.nickname})) } }, 409);
    }
    await env.DB.batch(results.map(player => env.DB.prepare(
      "DELETE FROM players WHERE id=? AND UPPER(nickname) LIKE 'DEMO %' AND UPPER(game_id) LIKE 'DEMO-%'"
    ).bind(player.id)));
    await audit(env.DB, auth.user.id, "demo_players_purged", "players", "bulk", null, { deleted: results.map(player => ({id:player.id,nickname:player.nickname,game_id:player.game_id})) });
    return json({ ok: true, deleted: results.length, players: results.map(player => ({id:player.id,nickname:player.nickname})) });
  }
  if (resource === "applications" && action === "review") {
    const registrationId = String(id || "").trim();
    const status = data.status;
    if (!registrationId || !["approved","rejected"].includes(status)) return bad("Укажите заявку и решение: approved или rejected.");
    const before = await env.DB.prepare(
      "SELECT r.*,t.status AS tournament_status,t.max_teams FROM tournament_registrations r JOIN tournaments t ON t.id=r.tournament_id WHERE r.id=?"
    ).bind(registrationId).first();
    if (!before) return bad("Заявка не найдена.", 404);
    if (before.status !== "pending") return bad("Эта заявка уже рассмотрена.", 409);
    if (status === "approved" && !["published","active"].includes(before.tournament_status)) {
      return bad("Нельзя одобрить заявку: турнир уже закрыт.", 409);
    }
    const recipient = await env.DB.prepare(
      "SELECT tm.captain_id,t.title AS tournament_title,tm.name AS team_name FROM teams tm JOIN tournaments t ON t.id=? WHERE tm.id=?"
    ).bind(before.tournament_id,before.team_id).first();
    const reviewedAt = now();
    const statements = [
      env.DB.prepare(
        "UPDATE tournament_registrations SET status=?,reviewed_at=?,reviewer_id=? WHERE id=? AND status='pending' AND (?!='approved' OR EXISTS (SELECT 1 FROM tournaments t WHERE t.id=? AND t.status IN ('published','active') AND (t.max_teams IS NULL OR (SELECT COUNT(*) FROM tournament_registrations approved WHERE approved.tournament_id=t.id AND approved.status='approved')<t.max_teams)))"
      ).bind(status,reviewedAt,auth.user.id,registrationId,status,before.tournament_id),
      env.DB.prepare(
        "INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) SELECT ?,?,?, 'tournament_registration',?,? WHERE EXISTS (SELECT 1 FROM tournament_registrations WHERE id=? AND status=? AND reviewer_id=? AND reviewed_at=?)"
      ).bind(await createAuditEventId(env.DB),auth.user.id,"registration_"+status,String(registrationId),JSON.stringify({status,tournament_id:before.tournament_id,team_id:before.team_id}),registrationId,status,auth.user.id,reviewedAt)
    ];
    if (recipient?.captain_id) {
      statements.push(env.DB.prepare(
        "INSERT INTO notifications (user_id,type,title,message,link,entity_type,entity_id) SELECT ?,?,?,?,?, 'tournament_registration',? WHERE EXISTS (SELECT 1 FROM tournament_registrations WHERE id=? AND status=? AND reviewer_id=? AND reviewed_at=?)"
      ).bind(recipient.captain_id,"application_"+status,status==="approved"?"Заявка одобрена":"Заявка отклонена",
        "Заявка команды "+recipient.team_name+" на турнир «"+recipient.tournament_title+"» "+(status==="approved"?"одобрена.":"отклонена."),
        "#/tournament/"+before.tournament_id,String(registrationId),registrationId,status,auth.user.id,reviewedAt));
    }
    const writes = await env.DB.batch(statements);
    if (!writes[0]?.meta?.changes) {
      if (status === "approved" && before.max_teams != null) {
        const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM tournament_registrations WHERE tournament_id=? AND status='approved'").bind(before.tournament_id).first();
        if ((count?.total || 0) >= before.max_teams) return bad("Лимит команд уже достигнут. Заявку нельзя одобрить.", 409);
      }
      return bad("Заявка уже обработана или турнир изменился другим запросом.", 409);
    }
    const after = await env.DB.prepare("SELECT * FROM tournament_registrations WHERE id=?").bind(registrationId).first();
    return json({ data: after });
  }
  const config = TABLES[resource];
  if (!config) return bad("Неизвестный раздел.");
  if (resource === "seasons" && action === "create" && data.id != null) {
    const duplicateId = await env.DB.prepare("SELECT id FROM seasons WHERE id=? LIMIT 1").bind(String(data.id)).first();
    if (duplicateId) return bad("Этот ID сезона уже занят. Укажи другой ID.", 409);
  }
  if (resource === "seasons" && data.season_number != null) {
    const number = Number(data.season_number);
    if (!Number.isSafeInteger(number) || number < 1) return bad("Номер сезона должен быть целым числом от 1.");
    const duplicate = await env.DB.prepare("SELECT id FROM seasons WHERE season_number=? AND (? IS NULL OR id!=?) LIMIT 1").bind(number, id == null ? null : String(id), id == null ? null : String(id)).first();
    if (duplicate) return bad("Этот номер сезона уже занят. Укажи другой номер.", 409);
  }
  if (!["create","update","delete","publish"].includes(action)) return bad("Неизвестное действие.");
  if (action === "delete") {
    const recordId = String(id || "").trim();
    if (!recordId) return bad("Некорректный ID.");
    const before = await getById(env.DB, config.table, recordId);
    if (!before) return bad("Запись не найдена.", 404);
    // Preserve foreign-key history: retire records instead of physically deleting them.
    if (resource === "teams") {
      const retiredAt = now();
      await env.DB.batch([
        env.DB.prepare("UPDATE teams SET status='dissolved',updated_at=? WHERE id=?").bind(retiredAt,recordId),
        env.DB.prepare("UPDATE players SET team_id=NULL,updated_at=? WHERE team_id=?").bind(retiredAt,recordId),
        env.DB.prepare("UPDATE team_roster SET left_at=? WHERE team_id=? AND left_at IS NULL").bind(retiredAt,recordId)
      ]);
      const after = await getById(env.DB, config.table, recordId);
      await audit(env.DB, auth.user.id, "teams_archived", resource, recordId, before, after);
      return json({ ok: true, archived: true, id: recordId, message: "Команда архивирована. История турниров и матчей сохранена." });
    }
    if (resource === "players") {
      const retiredAt = now();
      await env.DB.batch([
        env.DB.prepare("UPDATE players SET profile_status='rejected',team_id=NULL,updated_at=? WHERE id=?").bind(retiredAt,recordId),
        env.DB.prepare("UPDATE team_roster SET left_at=? WHERE player_id=? AND left_at IS NULL").bind(retiredAt,recordId)
      ]);
      const after = await getById(env.DB, config.table, recordId);
      await audit(env.DB, auth.user.id, "players_archived", resource, recordId, before, after);
      return json({ ok: true, archived: true, id: recordId, message: "Игрок архивирован. История участия и матчей сохранена." });
    }
    await env.DB.prepare("DELETE FROM " + config.table + " WHERE id=?").bind(recordId).run();
    await audit(env.DB, auth.user.id, resource + "_deleted", resource, recordId, before, null);
    return json({ ok: true, id: recordId });
  }
  const payload = {};
  try {
    for (const field of config.fields) {
      if (field === "id" && action !== "create") continue;
      if (Object.prototype.hasOwnProperty.call(data, field)) payload[field] = cleanValue(field, data[field]);
    }
  } catch (error) { return bad(error.message); }
  if (action === "publish") {
    if (resource !== "tournaments") return bad("Публиковать можно только турниры.");
    payload.status = "published";
  }
  if (resource === "seasons" && payload.season_number != null) {
    const number = Number(payload.season_number);
    if (!Number.isSafeInteger(number) || number < 1) return bad("Номер сезона должен быть целым числом от 1.");
    const duplicate = await env.DB.prepare("SELECT id FROM seasons WHERE season_number=? AND (? IS NULL OR id!=?) LIMIT 1").bind(number, id == null ? null : String(id), id == null ? null : String(id)).first();
    if (duplicate) return bad("Этот номер сезона уже занят. Укажи другой номер.", 409);
  }
  if (resource === "tournaments" && payload.season_id != null) {
    const season = await env.DB.prepare("SELECT id FROM seasons WHERE id=?").bind(payload.season_id).first();
    if (!season) return bad("Сезон с ID " + payload.season_id + " не найден. Сначала создайте сезон во вкладке «Сезоны» и укажите его реальный ID.");
  }
  // Validate every admin-supplied foreign key before writing. D1 may report
  // trigger-backed FK failures without identifying which submitted ID is invalid.
  async function requireRelated(table, value, label) {
    if (value == null || value === "") return null;
    const related = await env.DB.prepare("SELECT id FROM " + table + " WHERE id=? LIMIT 1").bind(value).first();
    return related ? null : bad(label + " с ID " + value + " не найден. Обнови список и выбери существующую запись.", 409);
  }
  if (resource === "players") {
    const userError = await requireRelated("users", payload.user_id, "Аккаунт пользователя");
    if (userError) return userError;
    const teamError = await requireRelated("teams", payload.team_id, "Команда");
    if (teamError) return teamError;
  }
  if (resource === "teams") {
    const captainError = await requireRelated("users", payload.captain_id, "Аккаунт капитана");
    if (captainError) return captainError;
  }
  if (resource === "matches") {
    for (const [field, table, label] of [
      ["tournament_id", "tournaments", "Турнир"],
      ["team_a_id", "teams", "Команда A"],
      ["team_b_id", "teams", "Команда B"],
      ["winner_team_id", "teams", "Команда-победитель"]
    ]) {
      const relatedError = await requireRelated(table, payload[field], label);
      if (relatedError) return relatedError;
    }
  }
  if (resource === "tournaments" && payload.format && !FORMATS.has(payload.format)) return bad("Недопустимый формат турнира.");
  if (payload.status && STATUSES[resource] && !STATUSES[resource].has(payload.status)) return bad("Недопустимый статус.");
  if (resource === "players" && payload.role && !["EXP","JUNGLE","MID","GOLD","ROAM","FLEX"].includes(payload.role)) return bad("Недопустимая игровая роль.");
  if (resource === "players" && payload.profile_status && !["pending","approved","rejected"].includes(payload.profile_status)) return bad("Недопустимый статус проверки профиля.");
  if (resource === "matches" && payload.bracket && !["main","upper","lower","group","final"].includes(payload.bracket)) return bad("Недопустимая сетка.");
  if (resource === "matches") {
    const teamA = payload.team_a_id;
    const teamB = payload.team_b_id;
    if (teamA != null && teamB != null && String(teamA) === String(teamB)) return bad("Одна команда не может играть сама с собой.");
    for (const field of ["score_a", "score_b"]) {
      if (payload[field] != null && (!Number.isSafeInteger(payload[field]) || payload[field] < 0)) return bad("Счёт матча должен быть целым неотрицательным числом.");
    }
    if (action === "create" && payload.status === "completed") return bad("Создай матч в расписании, затем внеси результат через редактирование матча.");
  }
  if (resource === "tournaments" && action === "create") {
    payload.game = payload.game || "Mobile Legends: Bang Bang";
    payload.organizer_id = auth.user.id;
  }
  if (resource === "tournaments" && (payload.status === "published" || payload.status === "active") && action !== "update") payload.published_at = now();
  if (resource === "matches" && action === "update") {
    const existing = await env.DB.prepare("SELECT team_a_id,team_b_id,status FROM matches WHERE id=? LIMIT 1").bind(String(id || "")).first();
    if (!existing) return bad("Матч не найден.", 404);
    const teamA = payload.team_a_id ?? existing.team_a_id;
    const teamB = payload.team_b_id ?? existing.team_b_id;
    if (teamA != null && teamB != null && String(teamA) === String(teamB)) return bad("Одна команда не может играть сама с собой.");
    if (payload.status === "in_progress" && (teamA == null || teamB == null)) return bad("Нельзя начать матч, пока не назначены обе команды.");
    if (existing.status === "completed" && payload.status && payload.status !== "completed") return bad("Завершённый матч нельзя отменить или перенести.");
  }
  if (resource === "matches" && payload.status === "completed") {
    if (payload.score_a == null || payload.score_b == null || payload.team_a_id == null || payload.team_b_id == null || payload.score_a === payload.score_b) return bad("Для завершённого матча нужны две команды и победный счёт.");
    if (payload.winner_team_id == null) payload.winner_team_id = payload.score_a > payload.score_b ? payload.team_a_id : payload.team_b_id;
    if (![payload.team_a_id,payload.team_b_id].includes(payload.winner_team_id)) return bad("Победитель должен быть одной из команд матча.");
    payload.result_source = "admin_manual";
    payload.result_verified_at = now();
  }
  const required = {
    tournaments:["title","format"], teams:["name","tag"], players:["user_id","game_id","nickname"],
    matches:["tournament_id","round_number","match_number"], seasons:["title","season_number","starts_at","ends_at"]
  }[resource];
  if (action === "create") {
    const missing = required.find((field) => !(field in payload) || payload[field] === null || payload[field] === "");
    if (missing) return bad("Заполните обязательное поле: " + missing);
    const fields = Object.keys(payload);
    const placeholders = fields.map(() => "?").join(",");
    const result = await env.DB.prepare("INSERT INTO " + config.table + " (" + fields.join(",") + ") VALUES (" + placeholders + ")")
      .bind(...fields.map((field) => payload[field])).run();
    const recordId = payload.id ?? result.meta?.last_row_id;
    const after = await getById(env.DB, config.table, recordId);
    await audit(env.DB, auth.user.id, resource + "_created", resource, recordId, null, after);
    return json({ data: after }, 201);
  }
  const recordId = String(id || "").trim();
  if (!recordId || !Object.keys(payload).length) return bad("Укажите ID и поля для изменения.");
  const before = await getById(env.DB, config.table, recordId);
  if (!before) return bad("Запись не найдена.", 404);
  if (resource === "tournaments" && (payload.status === "published" || payload.status === "active") && !before.published_at) payload.published_at = now();
  if (resource === "matches" && (payload.status === "completed" || before.status === "completed")) {
    if (before.status === "completed") {
      if (payload.status && payload.status !== "completed") return bad("Завершённый матч нельзя вернуть в активное расписание.", 409);
      if (payload.scheduled_at != null && String(payload.scheduled_at) !== String(before.scheduled_at ?? "")) {
        return bad("Расписание завершённого матча нельзя менять. Для исправления счёта используй отдельную корректировку результата.", 409);
      }
      if ((payload.team_a_id != null && String(payload.team_a_id) !== String(before.team_a_id)) ||
          (payload.team_b_id != null && String(payload.team_b_id) !== String(before.team_b_id))) {
        return bad("Нельзя менять участников уже завершённого матча.", 409);
      }
    }
    const a = payload.score_a ?? before.score_a, b = payload.score_b ?? before.score_b;
    const ta = payload.team_a_id ?? before.team_a_id, tb = payload.team_b_id ?? before.team_b_id;
    if (a == null || b == null || ta == null || tb == null || a === b) return bad("Для завершённого матча нужны две команды и победный счёт.");
    const winner = payload.winner_team_id ?? (a > b ? ta : tb);
    if (winner !== ta && winner !== tb) return bad("Победитель должен быть одной из команд матча.");
    if (before.status === "completed" && (
      Number(a) !== Number(before.score_a) ||
      Number(b) !== Number(before.score_b) ||
      String(winner) !== String(before.winner_team_id)
    )) return bad("Результат уже завершён. Изменение счёта или победителя требует отдельной корректировки турнирной сетки.", 409);
    payload.winner_team_id = winner;
    payload.result_source = before.status === "completed" ? (before.result_source || "admin_manual") : "admin_manual";
    payload.result_verified_at = before.status === "completed" ? (before.result_verified_at || now()) : now();
  }
  payload.updated_at = now();
  const fields = Object.keys(payload);
  const completingMatch = resource === "matches" && before.status !== "completed" && payload.status === "completed";
  const updateSql = "UPDATE " + config.table + " SET " + fields.map((field) => field + "=?").join(",") +
    " WHERE id=?" + (completingMatch ? " AND status!='completed'" : "");
  const updateResult = await env.DB.prepare(updateSql).bind(...fields.map((field) => payload[field]), recordId).run();
  if (completingMatch && !updateResult.meta?.changes) {
    return bad("Результат этого матча уже сохранён другим запросом. Обнови список матчей.", 409);
  }
  const after = await getById(env.DB, config.table, recordId);
  await audit(env.DB, auth.user.id, resource + "_updated", resource, recordId, before, after);
  if (resource === "seasons" && after.status === "active") {
    const { results: completedTournaments } = await env.DB.prepare(
      "SELECT id FROM tournaments WHERE season_id=? AND status='completed'"
    ).bind(recordId).all();
    for (const tournament of completedTournaments || []) {
      try { await finalizeCircuitTournament(env.DB, tournament.id); }
      catch (error) { console.error("Circuit backfill after season activation failed:", error); }
    }
  }
  if (resource === "matches" && after.status === "completed" && after.winner_team_id != null) {
    try {
      const progression = await advanceWinner(env.DB, recordId, after.winner_team_id);
      return json({ data: after, progression });
    } catch (progressionError) {
      console.error("Manual result bracket progression failed:", progressionError);
      return json({
        error: { code: "RESULT_SAVED_PROGRESSION_PENDING", message: "Результат матча сохранён, но победитель пока не продвинут по сетке. Повтори сохранение этого же результата после проверки следующего матча." },
        data: after,
        result_saved: true
      }, 503);
    }
  }
  return json({ data: after });
  } catch (error) {
    console.error("MERCY ARENA admin POST failed:", error);
    const detail = String(error && error.message || "Неизвестная ошибка").slice(0, 300);
    return json({ error: { code: "ADMIN_WRITE_FAILED", message: "Не удалось сохранить запись: " + detail } }, 500);
  }
}
export function onRequestPatch() { return methodNotAllowed("GET, POST"); }
export function onRequestDelete() { return methodNotAllowed("GET, POST"); }
