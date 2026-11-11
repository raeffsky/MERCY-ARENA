import { json, databaseUnavailable } from "./_lib/http.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";

const fail = (code, message, status = 400) => json({ error: { code, message } }, status);
const now = () => new Date().toISOString();
const MAX_MESSAGE_LENGTH = 1000;
const MAX_MESSAGES = 100;

async function authorize(request, env, matchId) {
  if (!env.DB) return { response: databaseUnavailable() };
  const auth = await getSessionUser(request, env);
  if (auth.error) return { response: auth.error };
  if (!auth.user) return { response: fail("UNAUTHORIZED", "Войди в аккаунт, чтобы открыть чат матча.", 401) };

  const match = await env.DB.prepare(
    "SELECT m.id,m.status,m.tournament_id,t.organizer_id,t.status AS tournament_status,t.published_at " +
    "FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=? LIMIT 1"
  ).bind(matchId).first();
  if (!match) return { response: fail("MATCH_NOT_FOUND", "Матч не найден.", 404) };

  const staff = await env.DB.prepare(
    "SELECT staff_role FROM tournament_staff WHERE tournament_id=? AND user_id=? LIMIT 1"
  ).bind(match.tournament_id, auth.user.id).first().catch(() => null);
  const owner = auth.user.roles.includes("administrator") && isOwnerAccount(auth.user, env);
  const organizer = owner || String(match.organizer_id) === String(auth.user.id) ||
    ["organizer", "admin"].includes(staff?.staff_role);
  const judge = staff?.staff_role === "referee";
  const observer = staff?.staff_role === "observer";
  const player = await env.DB.prepare(
    "SELECT p.id,p.team_id FROM players p JOIN teams t ON t.id=p.team_id " +
    "WHERE p.user_id=? AND p.profile_status='approved' AND p.archived_at IS NULL " +
    "AND t.status='active' AND t.archived_at IS NULL " +
    "AND EXISTS (SELECT 1 FROM team_roster tr WHERE tr.player_id=p.id AND tr.team_id=t.id AND tr.left_at IS NULL) " +
    "AND p.team_id IN (SELECT team_a_id FROM matches WHERE id=? UNION SELECT team_b_id FROM matches WHERE id=?) LIMIT 1"
  ).bind(auth.user.id, matchId, matchId).first().catch(() => null);
  const participant = !!player;
  if (!organizer && !judge && !observer && !participant) {
    return { response: fail("MATCH_ACCESS_DENIED", "Чат доступен только участникам матча и персоналу турнира.", 403) };
  }
  const active = !!match.published_at && ["published", "active"].includes(match.tournament_status) &&
    ["scheduled", "in_progress"].includes(match.status);
  return { db: env.DB, user: auth.user, match, canWrite: active && (organizer || judge || participant) };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const matchId = url.searchParams.get("id")?.trim();
  if (!matchId || matchId.length > 128) return fail("INVALID_MATCH", "Некорректный ID матча.");
  const auth = await authorize(request, env, matchId);
  if (auth.response) return auth.response;
  try {
    const rows = await auth.db.prepare(
      "SELECT c.id,c.user_id,c.message,c.created_at,COALESCE(p.nickname,u.username,'Участник') AS author " +
      "FROM match_chat_messages c JOIN users u ON u.id=c.user_id " +
      "LEFT JOIN players p ON p.user_id=u.id AND p.profile_status='approved' AND p.archived_at IS NULL " +
      "WHERE c.match_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT ?"
    ).bind(matchId, MAX_MESSAGES).all();
    return json({ data: { messages: (rows.results || []).reverse(), can_write: auth.canWrite,
      match_status: auth.match.status } }, 200, { "Cache-Control": "no-store, private" });
  } catch (error) {
    console.error("MERCY MATCH chat read failed:", error);
    return fail("MATCH_CHAT_READ_FAILED", "Не удалось загрузить чат матча.", 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) {
    return fail("ORIGIN_REJECTED", "Запрос отклонён.", 403);
  }
  let body;
  try { body = await request.json(); } catch { return fail("INVALID_JSON", "Некорректный JSON."); }
  const matchId = String(body?.match_id || "").trim();
  const message = String(body?.message || "").trim();
  if (!matchId || matchId.length > 128) return fail("INVALID_MATCH", "Некорректный ID матча.");
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return fail("INVALID_MESSAGE", "Сообщение должно содержать от 1 до 1000 символов.");
  }
  const auth = await authorize(request, env, matchId);
  if (auth.response) return auth.response;
  if (!auth.canWrite) return fail("CHAT_CLOSED", "Чат закрыт: матч завершён или турнир ещё не опубликован.", 409);

  try {
    const recent = await auth.db.prepare(
      "SELECT COUNT(*) AS total FROM match_chat_messages WHERE match_id=? AND user_id=? AND created_at>=?"
    ).bind(matchId, auth.user.id, new Date(Date.now() - 10000).toISOString()).first();
    if (Number(recent?.total || 0) >= 5) {
      return fail("CHAT_RATE_LIMITED", "Не так быстро. Подожди немного перед следующим сообщением.", 429);
    }
    const id = crypto.randomUUID();
    const createdAt = now();
    await auth.db.prepare(
      "INSERT INTO match_chat_messages (id,match_id,user_id,message,created_at) VALUES (?,?,?,?,?)"
    ).bind(id, matchId, auth.user.id, message, createdAt).run();
    const row = await auth.db.prepare(
      "SELECT c.id,c.user_id,c.message,c.created_at,COALESCE(p.nickname,u.username,'Участник') AS author " +
      "FROM match_chat_messages c JOIN users u ON u.id=c.user_id " +
      "LEFT JOIN players p ON p.user_id=u.id AND p.profile_status='approved' AND p.archived_at IS NULL " +
      "WHERE c.id=? LIMIT 1"
    ).bind(id).first();
    return json({ data: { message: row } }, 201, { "Cache-Control": "no-store, private" });
  } catch (error) {
    console.error("MERCY MATCH chat write failed:", error);
    return fail("MATCH_CHAT_WRITE_FAILED", "Не удалось отправить сообщение.", 500);
  }
}
