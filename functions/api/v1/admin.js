import { json, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";
import { advanceWinner } from "./_lib/match-progression.js";

const TABLES = {
  tournaments: { table: "tournaments", fields: ["title","description","game","region","format","status","max_teams","registration_open_at","registration_close_at","registration_slots","starts_at","ends_at","rules_url","season_id","prize_pool","poster_url"] },
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
  if (!session.user || !session.user.roles.includes("administrator")) {
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
    .bind(crypto.randomUUID(), actor, action, entity, String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
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
      ).bind(crypto.randomUUID(),auth.user.id,"registration_"+status,String(registrationId),JSON.stringify({status,tournament_id:before.tournament_id,team_id:before.team_id}),registrationId,status,auth.user.id,reviewedAt)
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
  if (resource === "tournaments" && payload.format && !FORMATS.has(payload.format)) return bad("Недопустимый формат турнира.");
  if (payload.status && STATUSES[resource] && !STATUSES[resource].has(payload.status)) return bad("Недопустимый статус.");
  if (resource === "players" && payload.role && !["EXP","JUNGLE","MID","GOLD","ROAM","FLEX"].includes(payload.role)) return bad("Недопустимая игровая роль.");
  if (resource === "players" && payload.profile_status && !["pending","approved","rejected"].includes(payload.profile_status)) return bad("Недопустимый статус проверки профиля.");
  if (resource === "matches" && payload.bracket && !["main","upper","lower","group","final"].includes(payload.bracket)) return bad("Недопустимая сетка.");
  if (resource === "tournaments" && action === "create") {
    payload.game = payload.game || "Mobile Legends: Bang Bang";
    payload.organizer_id = auth.user.id;
  }
  if (resource === "tournaments" && (payload.status === "published" || payload.status === "active") && action !== "update") payload.published_at = now();
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
  await env.DB.prepare("UPDATE " + config.table + " SET " + fields.map((field) => field + "=?").join(",") + " WHERE id=?")
    .bind(...fields.map((field) => payload[field]), recordId).run();
  const after = await getById(env.DB, config.table, recordId);
  await audit(env.DB, auth.user.id, resource + "_updated", resource, recordId, before, after);
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
