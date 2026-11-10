import { json, databaseUnavailable } from "./_lib/http.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";
import { createAuditEventId } from "./_lib/audit.js";

const fail = (code, message, status = 400) => json({ error: { code, message } }, status);
const now = () => new Date().toISOString();
const FORMATS = new Set(["BO1", "BO3", "BO5"]);
async function audit(db, actor, action, matchId, details) {
  await db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?,?)")
    .bind(await createAuditEventId(db), actor, action, "match_room", String(matchId), JSON.stringify(details || {})).run();
}

async function loadMatch(db, id) {
  return db.prepare(
    "SELECT m.id,m.tournament_id,m.round_number,m.bracket,m.match_number,m.scheduled_at,m.status," +
    "m.team_a_id,m.team_b_id,ta.name AS team_a_name,tb.name AS team_b_name,t.organizer_id,t.title AS tournament_title " +
    "FROM matches m JOIN tournaments t ON t.id=m.tournament_id " +
    "LEFT JOIN teams ta ON ta.id=m.team_a_id LEFT JOIN teams tb ON tb.id=m.team_b_id WHERE m.id=? LIMIT 1"
  ).bind(id).first();
}

async function accessFor(db, user, match, env) {
  const owner = user.roles.includes("administrator") && isOwnerAccount(user, env);
  const organizer = owner || String(match.organizer_id) === String(user.id);
  const judge = user.roles.includes("judge");
  const player = await db.prepare(
    "SELECT p.id,p.team_id,t.captain_id FROM players p " +
    "LEFT JOIN teams t ON t.id=p.team_id AND t.status='active' AND t.archived_at IS NULL " +
    "WHERE p.user_id=? AND p.profile_status='approved' AND p.archived_at IS NULL LIMIT 1"
  ).bind(user.id).first().catch(() => null);
  const roster = player ? await db.prepare(
    "SELECT team_id FROM team_roster WHERE player_id=? AND left_at IS NULL AND team_id IN (?,?) AND team_id=?"
  ).bind(player.id, match.team_a_id || "", match.team_b_id || "", player.team_id || "").all() : { results: [] };
  const teamIds = (roster.results || []).map(row => String(row.team_id));
  const captainA = !!(player && String(match.team_a_id) && String(player.team_id) === String(match.team_a_id) && String(player.captain_id) === String(user.id));
  const captainB = !!(player && String(match.team_b_id) && String(player.team_id) === String(match.team_b_id) && String(player.captain_id) === String(user.id));
  const participant = teamIds.length > 0 || captainA || captainB;
  return { owner, organizer, judge, participant, canManage: owner || organizer || judge, canReady: captainA || captainB,
    side: captainA ? "a" : captainB ? "b" : teamIds.includes(String(match.team_a_id)) ? "a" : teamIds.includes(String(match.team_b_id)) ? "b" : null };
}

function publicRoom(match, room, access) {
  const matchActive = ["scheduled", "in_progress"].includes(match.status);
  const credentialsVisible = !!room && matchActive && (access.canManage || !!room.room_published_at);
  return {
    match: { id: match.id, tournament_id: match.tournament_id, tournament_title: match.tournament_title,
      round_number: match.round_number, bracket: match.bracket, match_number: match.match_number,
      scheduled_at: match.scheduled_at, status: match.status, team_a_id: match.team_a_id,
      team_b_id: match.team_b_id, team_a_name: match.team_a_name, team_b_name: match.team_b_name },
    room: room ? { series_format: room.series_format, room_id: credentialsVisible ? room.room_id : null,
      room_password: credentialsVisible ? room.room_password : null, published: !!room.room_published_at && matchActive,
      judge_contact: room.judge_contact, instructions: room.instructions,
      team_a_ready: !!room.team_a_ready_at, team_b_ready: !!room.team_b_ready_at,
      team_a_ready_at: room.team_a_ready_at, team_b_ready_at: room.team_b_ready_at } :
      { series_format: "BO1", room_id: null, room_password: null, published: false, judge_contact: null,
        instructions: null, team_a_ready: false, team_b_ready: false },
    permissions: { can_manage: access.canManage && matchActive, can_ready: access.canReady && matchActive, side: access.side }
  };
}

async function authorize(request, env, id) {
  if (!env.DB) return { response: databaseUnavailable() };
  const auth = await getSessionUser(request, env);
  if (auth.error) return { response: auth.error };
  if (!auth.user) return { response: fail("UNAUTHORIZED", "Войди в аккаунт, чтобы открыть комнату матча.", 401) };
  const match = await loadMatch(env.DB, id);
  if (!match) return { response: fail("MATCH_NOT_FOUND", "Матч не найден.", 404) };
  const access = await accessFor(env.DB, auth.user, match, env);
  if (!access.canManage && !access.participant) return { response: fail("MATCH_ACCESS_DENIED", "Комната доступна только участникам матча, организатору, судье и администратору.", 403) };
  return { db: env.DB, user: auth.user, match, access };
}

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id || id.length > 128) return fail("INVALID_MATCH", "Некорректный ID матча.");
  const auth = await authorize(request, env, id);
  if (auth.response) return auth.response;
  try {
    const room = await auth.db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
    return json({ data: publicRoom(auth.match, room, auth.access) }, 200, { "Cache-Control": "no-store, private" });
  } catch (error) {
    console.error("MERCY MATCH room read failed:", error);
    return fail("MATCH_ROOM_READ_FAILED", "Не удалось загрузить игровую комнату.", 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return fail("ORIGIN_REJECTED", "Запрос отклонён.", 403);
  let body;
  try { body = await request.json(); } catch { return fail("INVALID_JSON", "Некорректный JSON."); }
  const id = String(body?.match_id || "").trim();
  if (!id || id.length > 128) return fail("INVALID_MATCH", "Некорректный ID матча.");
  const auth = await authorize(request, env, id);
  if (auth.response) return auth.response;
  const { db, user, match, access } = auth;
  const action = String(body.action || "");
  const timestamp = now();
  try {
    if (action === "configure") {
      if (!access.canManage) return fail("MANAGER_REQUIRED", "Настраивать комнату может организатор, судья или администратор.", 403);
      if (!["scheduled", "in_progress"].includes(match.status)) return fail("MATCH_NOT_CONFIGURABLE", "Комнату можно настраивать только для запланированного или текущего матча.", 409);
      const data = body.data && typeof body.data === "object" ? body.data : {};
      const format = String(data.series_format || "BO1").toUpperCase();
      if (!FORMATS.has(format)) return fail("INVALID_FORMAT", "Формат серии должен быть BO1, BO3 или BO5.");
      const roomId = String(data.room_id || "").trim();
      const password = String(data.room_password || "").trim();
      const judge = String(data.judge_contact || "").trim();
      const instructions = String(data.instructions || "").trim();
      if (roomId.length > 80 || password.length > 80 || judge.length > 160 || instructions.length > 1200)
        return fail("FIELD_TOO_LONG", "Проверь длину полей комнаты.");
      if (!!roomId !== !!password) return fail("ROOM_CREDENTIALS_REQUIRED", "Укажи одновременно ID и пароль комнаты либо очисти оба поля.");
      const publishedAt = data.publish && roomId && password ? timestamp : null;
      await db.prepare(
        "INSERT INTO match_rooms (match_id,series_format,room_id,room_password,room_published_at,judge_contact,instructions,created_by,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET series_format=excluded.series_format,room_id=excluded.room_id," +
        "room_password=excluded.room_password,room_published_at=excluded.room_published_at,judge_contact=excluded.judge_contact," +
        "instructions=excluded.instructions,updated_at=excluded.updated_at"
      ).bind(id, format, roomId || null, password || null, publishedAt, judge || null, instructions || null, user.id, timestamp, timestamp).run();
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      await audit(db, user.id, "match_room_configured", id, { series_format: format, published: !!publishedAt });
      return json({ data: publicRoom(match, room, access) }, 200, { "Cache-Control": "no-store, private" });
    }
    if (action === "ready") {
      if (!access.canReady || !access.side) return fail("CAPTAIN_REQUIRED", "Готовность может подтвердить только капитан одной из команд.", 403);
      if (!["scheduled", "in_progress"].includes(match.status)) return fail("MATCH_NOT_READY", "Подтвердить готовность можно только для запланированного или текущего матча.", 409);
      const column = access.side === "a" ? "team_a_ready_at" : "team_b_ready_at";
      await db.prepare(
        "INSERT INTO match_rooms (match_id,created_by,created_at,updated_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(match_id) DO NOTHING"
      ).bind(id, user.id, timestamp, timestamp).run();
      await db.prepare("UPDATE match_rooms SET " + column + "=COALESCE(" + column + ",?),updated_at=? WHERE match_id=?")
        .bind(timestamp, timestamp, id).run();
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      await audit(db, user.id, "match_team_ready", id, { side: access.side });
      return json({ data: publicRoom(match, room, access) }, 200, { "Cache-Control": "no-store, private" });
    }
    if (action === "reset_ready") {
      if (!access.canManage) return fail("MANAGER_REQUIRED", "Сбросить готовность может организатор, судья или администратор.", 403);
      if (!["scheduled", "in_progress"].includes(match.status)) return fail("MATCH_NOT_READY", "Готовность можно сбрасывать только для запланированного или текущего матча.", 409);
      const side = String(body.side || "both");
      if (!["a", "b", "both"].includes(side)) return fail("INVALID_SIDE", "Некорректная сторона матча.");
      if (side === "a" || side === "both") await db.prepare("UPDATE match_rooms SET team_a_ready_at=NULL,updated_at=? WHERE match_id=?").bind(timestamp, id).run();
      if (side === "b" || side === "both") await db.prepare("UPDATE match_rooms SET team_b_ready_at=NULL,updated_at=? WHERE match_id=?").bind(timestamp, id).run();
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      await audit(db, user.id, "match_readiness_reset", id, { side });
      return json({ data: publicRoom(match, room, access) }, 200, { "Cache-Control": "no-store, private" });
    }
    return fail("UNKNOWN_ACTION", "Неизвестное действие.");
  } catch (error) {
    console.error("MERCY MATCH room write failed:", error);
    return fail("MATCH_ROOM_WRITE_FAILED", "Не удалось сохранить данные игровой комнаты.", 500);
  }
}
