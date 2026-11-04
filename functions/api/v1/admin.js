import { json, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

const TABLES = {
  tournaments: { table: "tournaments", fields: ["title","description","game","region","format","status","max_teams","registration_open_at","registration_close_at","starts_at","ends_at","rules_url","season_id"] },
  teams: { table: "teams", fields: ["name","tag","logo_url","captain_id","region","status"] },
  players: { table: "players", fields: ["user_id","game_id","nickname","role","team_id","region"] },
  matches: { table: "matches", fields: ["tournament_id","round_number","bracket","match_number","scheduled_at","status","team_a_id","team_b_id","score_a","score_b","winner_team_id"] },
  seasons: { table: "seasons", fields: ["title","starts_at","ends_at","status"] }
};
const FORMATS = new Set(["single_elimination","double_elimination","round_robin","swiss","group_playoff"]);
const STATUSES = {
  tournaments: new Set(["draft","published","active","completed","cancelled"]),
  teams: new Set(["active","inactive","dissolved"]),
  players: null,
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
  const integerFields = new Set(["max_teams","season_id","captain_id","user_id","team_id","tournament_id","round_number","match_number","team_a_id","team_b_id","score_a","score_b","winner_team_id"]);
  const nullableFields = new Set(["description","region","logo_url","captain_id","max_teams","registration_open_at","registration_close_at","starts_at","ends_at","rules_url","season_id","role","team_id","scheduled_at","team_a_id","team_b_id","score_a","score_b","winner_team_id"]);
  if (value === "" && nullableFields.has(field)) return null;
  if (integerFields.has(field)) {
    if (value === null && nullableFields.has(field)) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Поле «" + field + "» должно быть целым числом.");
    return n;
  }
  if (value === null && nullableFields.has(field)) return null;
  if (typeof value !== "string") throw new Error("Некорректное значение поля «" + field + "».");
  const v = value.trim();
  if (v.length > 2000) throw new Error("Слишком длинное значение поля «" + field + "».");
  return v || (nullableFields.has(field) ? null : "");
}
async function audit(db, actor, action, entity, id, before, after) {
  await db.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?)")
    .bind(actor, action, entity, Number(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
}
async function getById(db, table, id) {
  return db.prepare("SELECT * FROM " + table + " WHERE id=?").bind(id).first();
}

export async function onRequestGet({ request, env }) {
  const auth = await authorize(request, env);
  if (auth.response) return auth.response;
  const resource = new URL(request.url).searchParams.get("resource") || "";
  if (resource === "applications") {
    const { results } = await env.DB.prepare(`SELECT r.id,r.tournament_id,r.team_id,r.status,r.submitted_at,r.reviewed_at,r.reviewer_id,t.title AS tournament_title,tm.name AS team_name,tm.tag AS team_tag FROM tournament_registrations r JOIN tournaments t ON t.id=r.tournament_id JOIN teams tm ON tm.id=r.team_id ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.submitted_at DESC LIMIT 200`).all();
    return json({ data: results || [] });
  }
  if (resource === "users") {
    const { results } = await env.DB.prepare("SELECT id,email,display_name FROM users ORDER BY email COLLATE NOCASE LIMIT 200").all();
    return json({ data: results || [] });
  }
  const config = TABLES[resource];
  if (!config) return bad("Неизвестный раздел.");
  const { results } = await env.DB.prepare("SELECT * FROM " + config.table + " ORDER BY id DESC LIMIT 200").all();
  return json({ data: results || [] });
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await authorize(request, env);
  if (auth.response) return auth.response;
  let body;
  try { body = await request.json(); } catch { return bad("Некорректный JSON."); }
  const { resource, action = "create", id, data = {} } = body || {};
  if (resource === "applications" && action === "review") {
    const registrationId = Number(id);
    const status = data.status;
    if (!Number.isSafeInteger(registrationId) || registrationId < 1 || !["approved","rejected"].includes(status)) return bad("Укажите заявку и решение: approved или rejected.");
    const before = await env.DB.prepare("SELECT * FROM tournament_registrations WHERE id=?").bind(registrationId).first();
    if (!before) return bad("Заявка не найдена.", 404);
    if (before.status !== "pending") return bad("Эта заявка уже рассмотрена.", 409);
    await env.DB.prepare("UPDATE tournament_registrations SET status=?,reviewed_at=?,reviewer_id=? WHERE id=? AND status='pending'")
      .bind(status, now(), auth.user.id, registrationId).run();
    const after = await env.DB.prepare("SELECT * FROM tournament_registrations WHERE id=?").bind(registrationId).first();
    await audit(env.DB, auth.user.id, "registration_" + status, "tournament_registration", registrationId, before, after);
    return json({ data: after });
  }
  const config = TABLES[resource];
  if (!config) return bad("Неизвестный раздел.");
  if (!["create","update","delete","publish"].includes(action)) return bad("Неизвестное действие.");
  if (action === "delete") {
    const recordId = Number(id);
    if (!Number.isSafeInteger(recordId) || recordId < 1) return bad("Некорректный ID.");
    const before = await getById(env.DB, config.table, recordId);
    if (!before) return bad("Запись не найдена.", 404);
    await env.DB.prepare("DELETE FROM " + config.table + " WHERE id=?").bind(recordId).run();
    await audit(env.DB, auth.user.id, resource + "_deleted", resource, recordId, before, null);
    return json({ ok: true, id: recordId });
  }
  const payload = {};
  try {
    for (const field of config.fields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) payload[field] = cleanValue(field, data[field]);
    }
  } catch (error) { return bad(error.message); }
  if (action === "publish") {
    if (resource !== "tournaments") return bad("Публиковать можно только турниры.");
    payload.status = "published";
  }
  if (resource === "tournaments" && payload.format && !FORMATS.has(payload.format)) return bad("Недопустимый формат турнира.");
  if (payload.status && STATUSES[resource] && !STATUSES[resource].has(payload.status)) return bad("Недопустимый статус.");
  if (resource === "players" && payload.role && !["EXP","JUNGLE","MID","GOLD","ROAM","FLEX"].includes(payload.role)) return bad("Недопустимая игровая роль.");
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
  }
  const required = {
    tournaments:["title","format"], teams:["name","tag"], players:["user_id","game_id","nickname"],
    matches:["tournament_id","round_number","match_number"], seasons:["title","starts_at","ends_at"]
  }[resource];
  if (action === "create") {
    const missing = required.find((field) => !(field in payload) || payload[field] === null || payload[field] === "");
    if (missing) return bad("Заполните обязательное поле: " + missing);
    const fields = Object.keys(payload);
    const placeholders = fields.map(() => "?").join(",");
    const result = await env.DB.prepare("INSERT INTO " + config.table + " (" + fields.join(",") + ") VALUES (" + placeholders + ")")
      .bind(...fields.map((field) => payload[field])).run();
    const recordId = result.meta?.last_row_id;
    const after = await getById(env.DB, config.table, recordId);
    await audit(env.DB, auth.user.id, resource + "_created", resource, recordId, null, after);
    return json({ data: after }, 201);
  }
  const recordId = Number(id);
  if (!Number.isSafeInteger(recordId) || recordId < 1 || !Object.keys(payload).length) return bad("Укажите ID и поля для изменения.");
  const before = await getById(env.DB, config.table, recordId);
  if (!before) return bad("Запись не найдена.", 404);
  if (resource === "tournaments" && (payload.status === "published" || payload.status === "active") && !before.published_at) payload.published_at = now();
  if (resource === "matches" && payload.status === "completed") {
    const a = payload.score_a ?? before.score_a, b = payload.score_b ?? before.score_b;
    const ta = payload.team_a_id ?? before.team_a_id, tb = payload.team_b_id ?? before.team_b_id;
    if (a == null || b == null || ta == null || tb == null || a === b) return bad("Для завершённого матча нужны две команды и победный счёт.");
    const winner = payload.winner_team_id ?? (a > b ? ta : tb);
    if (winner !== ta && winner !== tb) return bad("Победитель должен быть одной из команд матча.");
    payload.winner_team_id = winner;
    payload.result_source = "admin_manual";
    payload.result_verified_at = now();
  }
  payload.updated_at = now();
  const fields = Object.keys(payload);
  await env.DB.prepare("UPDATE " + config.table + " SET " + fields.map((field) => field + "=?").join(",") + " WHERE id=?")
    .bind(...fields.map((field) => payload[field]), recordId).run();
  const after = await getById(env.DB, config.table, recordId);
  await audit(env.DB, auth.user.id, resource + "_updated", resource, recordId, before, after);
  return json({ data: after });
}
export function onRequestPatch() { return methodNotAllowed("GET, POST"); }
export function onRequestDelete() { return methodNotAllowed("GET, POST"); }
