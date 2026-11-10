import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { createAuditEventId } from "./_lib/audit.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";

const fail = (code, message, status = 400) => json({ error: { code, message } }, status);
const now = () => new Date().toISOString();

function checkinWindow(tournament, current = Date.now()) {
  const starts = tournament.starts_at ? Date.parse(tournament.starts_at) : NaN;
  const open = tournament.checkin_open_at ? Date.parse(tournament.checkin_open_at) : (Number.isFinite(starts) ? starts - 60 * 60 * 1000 : NaN);
  const close = tournament.checkin_close_at ? Date.parse(tournament.checkin_close_at) : (Number.isFinite(starts) ? starts + 15 * 60 * 1000 : NaN);
  const valid = Number.isFinite(open) && Number.isFinite(close) && open <= close;
  return {
    open_at: valid ? new Date(open).toISOString() : null,
    close_at: valid ? new Date(close).toISOString() : null,
    is_open: valid && current >= open && current <= close,
    is_closed: valid && current > close,
    configured: valid
  };
}

async function loadAccess(db, tournament, user, env) {
  const owner = user.roles.includes("administrator") && isOwnerAccount(user, env);
  const staff = await db.prepare("SELECT staff_role FROM tournament_staff WHERE tournament_id=? AND user_id=? LIMIT 1")
    .bind(tournament.id, user.id).first().catch(() => null);
  const organizer = owner || String(tournament.organizer_id) === String(user.id) || ["organizer", "admin"].includes(staff?.staff_role);
  const referee = staff?.staff_role === "referee";
  const observer = staff?.staff_role === "observer";
  return { owner, organizer, referee, observer, canManage: organizer || referee };
}

async function loadRows(db, tournamentId, includeNotes) {
  const noteColumn = includeNotes ? ",c.note" : "";
  const { results } = await db.prepare(
    "SELECT r.id AS registration_id,r.team_id,tm.name AS team_name,tm.captain_id,r.status AS registration_status," +
    "c.status AS checkin_status,c.checked_in_at,c.decision_at" + noteColumn +
    " FROM tournament_registrations r JOIN teams tm ON tm.id=r.team_id " +
    "LEFT JOIN tournament_checkins c ON c.registration_id=r.id " +
    "WHERE r.tournament_id=? AND r.status='approved' AND tm.status='active' AND tm.archived_at IS NULL " +
    "ORDER BY tm.name COLLATE NOCASE"
  ).bind(tournamentId).all();
  return (results || []).map(row => ({
    registration_id: row.registration_id, team_id: row.team_id, team_name: row.team_name,
    captain_id: row.captain_id, registration_status: row.registration_status,
    status: row.checkin_status || "pending", checked_in_at: row.checked_in_at || null,
    decision_at: row.decision_at || null, ...(includeNotes ? { note: row.note || null } : {})
  }));
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const session = await getSessionUser(request, env);
  if (session.error) return session.error;
  if (!session.user) return fail("UNAUTHORIZED", "Войди в аккаунт, чтобы открыть check-in.", 401);
  const tournamentId = String(new URL(request.url).searchParams.get("tournament_id") || "").trim();
  if (!tournamentId) return fail("INVALID_TOURNAMENT", "Не указан ID турнира.");
  const tournament = await env.DB.prepare(
    "SELECT id,title,status,published_at,starts_at,checkin_required,checkin_open_at,checkin_close_at,organizer_id FROM tournaments WHERE id=? LIMIT 1"
  ).bind(tournamentId).first();
  if (!tournament) return fail("TOURNAMENT_NOT_FOUND", "Турнир не найден.", 404);
  const access = await loadAccess(env.DB, tournament, session.user, env);
  const ownRegistration = await env.DB.prepare(
    "SELECT r.id,r.team_id,tm.captain_id FROM tournament_registrations r JOIN teams tm ON tm.id=r.team_id " +
    "WHERE r.tournament_id=? AND r.status='approved' AND tm.status='active' AND tm.archived_at IS NULL " +
    "AND (tm.captain_id=? OR EXISTS (SELECT 1 FROM players p JOIN team_roster tr ON tr.player_id=p.id AND tr.team_id=tm.id AND tr.left_at IS NULL " +
    "WHERE p.user_id=? AND p.team_id=tm.id AND p.profile_status='approved' AND p.archived_at IS NULL)) LIMIT 1"
  ).bind(tournamentId, session.user.id, session.user.id).first();
  if (!access.canManage && !access.observer && !ownRegistration)
    return fail("CHECKIN_ACCESS_DENIED", "Check-in доступен капитану зарегистрированной команды и персоналу турнира.", 403);
  const window = checkinWindow(tournament);
  const rows = await loadRows(env.DB, tournamentId, access.canManage);
  const own = rows.find(row => String(row.team_id) === String(ownRegistration?.team_id)) || null;
  const tournamentLive = !!tournament.published_at && ["published", "active"].includes(tournament.status);
  return json({ data: {
    tournament: { id: tournament.id, title: tournament.title, status: tournament.status,
      checkin_required: !!tournament.checkin_required, starts_at: tournament.starts_at },
    window,
    checkins: rows,
    permissions: {
      can_manage: access.canManage,
      can_check_in: !!ownRegistration && String(ownRegistration.captain_id) === String(session.user.id) && !!tournament.checkin_required && tournamentLive && window.is_open && own?.status === "pending",
      own_team_id: ownRegistration?.team_id || null
    }
  } }, 200, { "Cache-Control": "no-store, private" });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!sameOrigin(request, env)) return fail("ORIGIN_MISMATCH", "Недопустимый источник запроса.", 403);
  const session = await getSessionUser(request, env);
  if (session.error) return session.error;
  if (!session.user) return fail("UNAUTHORIZED", "Войди в аккаунт.", 401);
  let body;
  try { body = await request.json(); } catch { return fail("INVALID_JSON", "Некорректный JSON."); }
  const action = String(body.action || "");
  if (!["check_in", "mark_no_show", "excuse", "reset"].includes(action))
    return fail("UNKNOWN_ACTION", "Неизвестное действие.");
  const tournamentId = String(body.tournament_id || "").trim();
  const teamId = String(body.team_id || "").trim();
  if (!tournamentId || !teamId) return fail("INVALID_TARGET", "Укажи турнир и команду.");
  const tournament = await env.DB.prepare(
    "SELECT id,title,status,published_at,starts_at,checkin_required,checkin_open_at,checkin_close_at,organizer_id FROM tournaments WHERE id=? LIMIT 1"
  ).bind(tournamentId).first();
  if (!tournament) return fail("TOURNAMENT_NOT_FOUND", "Турнир не найден.", 404);
  if (!tournament.checkin_required) return fail("CHECKIN_DISABLED", "Для этого турнира check-in не обязателен.", 409);
  const registration = await env.DB.prepare(
    "SELECT r.id,r.status,tm.id AS team_id,tm.name AS team_name,tm.captain_id,tm.status AS team_status,tm.archived_at " +
    "FROM tournament_registrations r JOIN teams tm ON tm.id=r.team_id WHERE r.tournament_id=? AND r.team_id=? LIMIT 1"
  ).bind(tournamentId, teamId).first();
  if (!registration || registration.status !== "approved" || registration.team_status !== "active" || registration.archived_at)
    return fail("REGISTRATION_NOT_APPROVED", "Команда не имеет действующей одобренной заявки.", 409);
  const access = await loadAccess(env.DB, tournament, session.user, env);
  const window = checkinWindow(tournament);
  const current = now();
  const existing = await env.DB.prepare("SELECT * FROM tournament_checkins WHERE tournament_id=? AND team_id=?")
    .bind(tournamentId, teamId).first();
  if (action === "check_in") {
    if (String(registration.captain_id) !== String(session.user.id))
      return fail("CAPTAIN_REQUIRED", "Подтвердить участие может только капитан команды.", 403);
    if (!tournament.published_at || !["published", "active"].includes(tournament.status))
      return fail("TOURNAMENT_NOT_ACTIVE", "Check-in доступен только в опубликованном турнире.", 409);
    if (!window.configured) return fail("CHECKIN_WINDOW_UNAVAILABLE", "У турнира не задано время начала или окно check-in.", 409);
    if (!window.is_open) return fail("CHECKIN_WINDOW_CLOSED", "Сейчас check-in закрыт. Окно: "+window.open_at+" — "+window.close_at+".", 409);
    if (existing?.status === "checked_in")
      return json({ data: { tournament_id: tournamentId, team_id: teamId, status: "checked_in", checked_in_at: existing.checked_in_at, already_checked_in: true } });
    if (existing?.status === "no_show")
      return fail("TEAM_MARKED_NO_SHOW", "Команда уже отмечена как неявившаяся. Обратись к организатору.", 409);
  } else {
    if (!access.canManage) return fail("STAFF_REQUIRED", "Изменять отметки check-in может только организатор, судья или администратор турнира.", 403);
    if (!tournament.published_at || !["published","active"].includes(tournament.status)) return fail("TOURNAMENT_NOT_ACTIVE", "Изменять check-in можно только в опубликованном или активном турнире.", 409);
    if (action === "mark_no_show" && (!window.configured || !window.is_closed))
      return fail("CHECKIN_WINDOW_STILL_OPEN", "Неявку можно отметить только после закрытия окна check-in.", 409);
    if (["mark_no_show","excuse"].includes(action) && ["checked_in", "excused"].includes(existing?.status))
      return fail("CHECKIN_ALREADY_ACCEPTED", "Команда уже отметилась или получила освобождение от check-in.", 409);
  }
  const nextStatus = action === "check_in" ? "checked_in" : action === "mark_no_show" ? "no_show" : action === "excuse" ? "excused" : "pending";
  const note = String(body.note || "").trim().slice(0, 500) || null;
  const checkinId = existing?.id || crypto.randomUUID();
  const checkedInBy = nextStatus === "checked_in" ? session.user.id : null;
  const checkedInAt = nextStatus === "checked_in" ? current : null;
  const decisionBy = nextStatus === "pending" ? session.user.id : (nextStatus === "checked_in" ? null : session.user.id);
  const decisionAt = nextStatus === "checked_in" ? null : current;
  const before = existing ? { status: existing.status, checked_in_at: existing.checked_in_at, note: existing.note } : null;
  const after = { status: nextStatus, checked_in_at: checkedInAt, note };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tournament_checkins (id,tournament_id,team_id,registration_id,status,checked_in_by,checked_in_at,decision_by,decision_at,note,created_at,updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tournament_id,team_id) DO UPDATE SET registration_id=excluded.registration_id,status=excluded.status," +
      "checked_in_by=excluded.checked_in_by,checked_in_at=excluded.checked_in_at,decision_by=excluded.decision_by,decision_at=excluded.decision_at,note=excluded.note,updated_at=excluded.updated_at"
    ).bind(checkinId,tournamentId,teamId,registration.id,nextStatus,checkedInBy,checkedInAt,decisionBy,decisionAt,note,current,current),
    env.DB.prepare(
      "INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?,?)"
    ).bind(await createAuditEventId(env.DB),session.user.id,"tournament_checkin_"+action,"tournament_checkin",tournamentId+":"+teamId,before?JSON.stringify(before):null,JSON.stringify(after))
  ]);
  return json({ data: { tournament_id: tournamentId, team_id: teamId, status: nextStatus, checked_in_at: checkedInAt, note } });
}

export async function onRequest({ request, env }) {
  if (request.method === "GET") return onRequestGet({ request, env });
  if (request.method === "POST") return onRequestPost({ request, env });
  return methodNotAllowed(["GET", "POST"]);
}
