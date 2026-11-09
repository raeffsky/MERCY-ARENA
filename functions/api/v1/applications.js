import { createAuditEventId } from "./_lib/audit.js";
import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

async function currentUser(request, env) {
  if (!env.DB) return { response: databaseUnavailable() };
  const auth = await getSessionUser(request, env);
  if (auth.error) return { response: auth.error };
  if (!auth.user) return { response: json({ error: { code: "AUTH_REQUIRED", message: "Войди в аккаунт, чтобы подать заявку." } }, 401) };
  return { user: auth.user };
}

function invalid(message, status = 400, code = "INVALID_APPLICATION") {
  return json({ error: { code, message } }, status);
}

async function tournamentConfig(db, tournamentId, includePublished = false) {
  // Production D1 may lag behind the repository schema. Build the projection
  // from the columns that actually exist instead of failing on an optional field.
  const info = await db.prepare("PRAGMA table_info(tournaments)").all();
  const columns = new Set((info.results || []).map((column) => column.name));
  if (!columns.has("id")) throw new Error("tournaments table is missing its id column");
  const fields = ["id", "title", "status", "max_teams", "registration_open_at", "registration_close_at", "registration_slots"];
  const projection = fields.map((name) => columns.has(name) ? name : (name === "title" && columns.has("name") ? "name AS title" : "NULL AS " + name));
  if (includePublished && !columns.has("published_at")) return null;
  const publishedFilter = includePublished ? " AND published_at IS NOT NULL" : "";
  return db.prepare(
    "SELECT " + projection.join(",") + " FROM tournaments WHERE id=?" + publishedFilter
  ).bind(tournamentId).first();
}

async function hasTable(db, table) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first());
}

export async function onRequestGet({ request, env }) {
  let stage = "session";
  try {
  const auth = await currentUser(request, env);
  if (auth.response) return auth.response;
  stage = "tournament_config";
  const tournamentId = new URL(request.url).searchParams.get("tournament_id") || "";
  const tournamentConfigRow = await tournamentConfig(env.DB, tournamentId);
  const tournamentSettings = tournamentConfigRow && { registration_slots: tournamentConfigRow.registration_slots };
  const availableSlots = String(tournamentSettings?.registration_slots || "").split(/\r?\n/).map((slot) => slot.trim()).filter(Boolean).slice(0, 20);
  let results = [];
  stage = "team_lookup";
  try {
    const response = await env.DB.prepare(
      `SELECT t.id,t.name,t.tag,t.region,r.id AS registration_id,r.status AS application_status,
        r.selected_slot,r.captain_note,r.submitted_at,r.reviewed_at,
        (SELECT COUNT(*) FROM team_roster tr JOIN players roster_player ON roster_player.id=tr.player_id WHERE tr.team_id=t.id AND tr.left_at IS NULL AND roster_player.profile_status='approved' AND roster_player.archived_at IS NULL) AS roster_count
       FROM teams t
       LEFT JOIN tournament_registrations r ON r.team_id=t.id AND r.tournament_id=?
       WHERE t.status='active' AND t.archived_at IS NULL AND (t.captain_id=? OR EXISTS (SELECT 1 FROM team_roster cr JOIN players cp ON cp.id=cr.player_id WHERE cr.team_id=t.id AND cr.left_at IS NULL AND cr.roster_role='captain' AND cp.user_id=?))
       ORDER BY t.name COLLATE NOCASE`
    ).bind(tournamentId, auth.user.id, auth.user.id).all();
    results = response.results || [];
  } catch (error) {
    const message = String(error?.message || error);
    if (/no such column:\s*(?:r\.)?(?:selected_slot|captain_note|updated_at)|no such table:\s*tournament_registrations/i.test(message)) {
      const response = await env.DB.prepare(
        `SELECT t.id,t.name,t.tag,t.region,r.id AS registration_id,r.status AS application_status,
          NULL AS selected_slot,NULL AS captain_note,r.submitted_at,r.reviewed_at,
          (SELECT COUNT(*) FROM team_roster tr JOIN players roster_player ON roster_player.id=tr.player_id WHERE tr.team_id=t.id AND tr.left_at IS NULL AND roster_player.profile_status='approved' AND roster_player.archived_at IS NULL) AS roster_count
         FROM teams t
         LEFT JOIN tournament_registrations r ON r.team_id=t.id AND r.tournament_id=?
         WHERE t.status='active' AND t.archived_at IS NULL AND (t.captain_id=? OR EXISTS (SELECT 1 FROM team_roster cr JOIN players cp ON cp.id=cr.player_id WHERE cr.team_id=t.id AND cr.left_at IS NULL AND cr.roster_role='captain' AND cp.user_id=?))
         ORDER BY t.name COLLATE NOCASE`
      ).bind(tournamentId, auth.user.id, auth.user.id).all().catch(async (fallbackError) => {
        if (!/no such table:\s*tournament_registrations/i.test(String(fallbackError?.message || fallbackError))) throw fallbackError;
        return env.DB.prepare(
          `SELECT t.id,t.name,t.tag,t.region,NULL AS registration_id,NULL AS application_status,
            NULL AS selected_slot,NULL AS captain_note,NULL AS submitted_at,NULL AS reviewed_at,
            (SELECT COUNT(*) FROM team_roster tr JOIN players roster_player ON roster_player.id=tr.player_id WHERE tr.team_id=t.id AND tr.left_at IS NULL AND roster_player.profile_status='approved' AND roster_player.archived_at IS NULL) AS roster_count
           FROM teams t WHERE t.status='active' AND t.archived_at IS NULL AND (t.captain_id=? OR EXISTS (SELECT 1 FROM team_roster cr JOIN players cp ON cp.id=cr.player_id WHERE cr.team_id=t.id AND cr.left_at IS NULL AND cr.roster_role='captain' AND cp.user_id=?)) ORDER BY t.name COLLATE NOCASE`
        ).bind(auth.user.id, auth.user.id).all();
      });
      results = response.results || [];
    } else {
      console.error("Tournament application team lookup failed:", error);
      return json({ error: { code: "APPLICATION_TEAMS_UNAVAILABLE", message: "Не удалось загрузить команды. Проверь, что миграции платформы применены." } }, 503);
    }
  }
  const rows = results;
  stage = "team_roster";
  for (const row of rows) {
    let available;
    try {
      available = await env.DB.prepare(
        `SELECT p.id,p.nickname,p.role,p.game_id,p.server_id,
          CASE WHEN p.user_id=t.captain_id THEN 'captain' ELSE COALESCE(tr.roster_role,'player') END AS team_role
         FROM team_roster tr JOIN players p ON p.id=tr.player_id JOIN teams t ON t.id=tr.team_id
         WHERE tr.team_id=? AND tr.left_at IS NULL AND p.profile_status='approved' AND p.archived_at IS NULL
         ORDER BY CASE WHEN p.user_id=t.captain_id THEN 0 ELSE 1 END,p.nickname COLLATE NOCASE`
      ).bind(row.id).all();
    } catch (error) {
      if (!/no such column:\s*(?:p\.)?(?:profile_status|server_id)/i.test(String(error?.message || error))) throw error;
      available = await env.DB.prepare(
        `SELECT p.id,p.nickname,p.role,p.game_id,
          CASE WHEN p.user_id=t.captain_id THEN 'captain' ELSE COALESCE(tr.roster_role,'player') END AS team_role
         FROM team_roster tr JOIN players p ON p.id=tr.player_id JOIN teams t ON t.id=tr.team_id
         WHERE tr.team_id=? AND tr.left_at IS NULL AND p.archived_at IS NULL
         ORDER BY CASE WHEN p.user_id=t.captain_id THEN 0 ELSE 1 END,p.nickname COLLATE NOCASE`
      ).bind(row.id).all();
    }
    row.available_players = available.results || [];
    row.available_slots = availableSlots;
    if (!row.registration_id) { row.roster = []; continue; }
    try {
      const roster = await env.DB.prepare(
        `SELECT p.id,p.nickname,p.role,p.game_id,p.server_id,rr.roster_role
         FROM tournament_registration_roster rr JOIN players p ON p.id=rr.player_id
         WHERE rr.registration_id=?
         ORDER BY CASE rr.roster_role WHEN 'starter' THEN 0 ELSE 1 END,p.nickname COLLATE NOCASE`
      ).bind(row.registration_id).all();
      row.roster = roster.results || [];
    } catch (error) {
      if (!/no such table:\s*tournament_registration_roster/i.test(String(error?.message || error))) throw error;
      row.roster = [];
      row.roster_unavailable = true;
    }
  }
  return json({ data: rows });
  } catch (error) {
    const diagnostic = String(error?.message || error || "Unknown database error").replace(/[\\r\\n]+/g, " ").slice(0, 220);
    console.error("Tournament application lookup failed at stage " + stage + ":", error);
    return json({ error: {
      code: "APPLICATION_LOOKUP_FAILED",
      message: "Не удалось загрузить данные заявки (этап: " + stage + ").",
      stage,
      diagnostic
    } }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return invalid("Запрос отклонён.", 403, "ORIGIN_REJECTED");
  const auth = await currentUser(request, env);
  if (auth.response) return auth.response;
  let body;
  try { body = await request.json(); } catch { return invalid("Проверь данные заявки.", 400, "INVALID_JSON"); }

  const tournamentId = String(body.tournament_id || "").trim();
  const teamId = String(body.team_id || "").trim();
  const selectedSlot = String(body.selected_slot || "").trim().slice(0, 120);
  const captainNote = String(body.captain_note || "").trim().slice(0, 1000);
  if (!tournamentId || !teamId) return invalid("Выбери команду для участия.", 400, "MISSING_FIELDS");

  const tournament = await tournamentConfig(env.DB, tournamentId, true);
  if (!tournament || !["published","active"].includes(tournament.status)) return invalid("Регистрация на этот турнир сейчас закрыта.", 409, "REGISTRATION_CLOSED");
  const nowMs = Date.now();
  const opensAt = tournament.registration_open_at ? Date.parse(tournament.registration_open_at) : null;
  const closesAt = tournament.registration_close_at ? Date.parse(tournament.registration_close_at) : null;
  if ((opensAt !== null && !Number.isFinite(opensAt)) || (closesAt !== null && !Number.isFinite(closesAt)) ||
      (opensAt !== null && closesAt !== null && opensAt > closesAt)) {
    return invalid("Организатор указал некорректные сроки регистрации. Сообщи ему об этой ошибке.", 503, "REGISTRATION_CONFIG_INVALID");
  }
  if (opensAt !== null && nowMs < opensAt) return invalid("Регистрация ещё не началась.", 409, "REGISTRATION_NOT_STARTED");
  if (closesAt !== null && nowMs > closesAt) return invalid("Срок подачи заявок завершён.", 409, "REGISTRATION_CLOSED");
  const now = new Date(nowMs).toISOString();

  if (!await hasTable(env.DB, "tournament_registration_roster")) {
    return invalid("Система состава турнира ещё не настроена. Организатору нужно применить миграцию 0013_platform_foundation.sql.", 503, "ROSTER_MIGRATION_REQUIRED");
  }

  const team = await env.DB.prepare(
    "SELECT t.id,t.name,t.tag FROM teams t WHERE t.id=? AND t.status='active' AND t.archived_at IS NULL AND (t.captain_id=? OR EXISTS (SELECT 1 FROM team_roster cr JOIN players cp ON cp.id=cr.player_id WHERE cr.team_id=t.id AND cr.left_at IS NULL AND cr.roster_role='captain' AND cp.user_id=?))"
  ).bind(teamId, auth.user.id, auth.user.id).first();
  if (!team) return invalid("Подать заявку может только капитан активной команды.", 403, "TEAM_NOT_MANAGED");

  const { results: members } = await env.DB.prepare(
    `SELECT p.id,p.nickname,p.role FROM team_roster tr
     JOIN players p ON p.id=tr.player_id
     WHERE tr.team_id=? AND tr.left_at IS NULL AND p.profile_status='approved' AND p.archived_at IS NULL
     ORDER BY CASE tr.roster_role WHEN 'captain' THEN 0 ELSE 1 END,p.created_at ASC`
  ).bind(teamId).all();
  const memberIds = new Set((members || []).map((p) => String(p.id)));
  const requestedIds = Array.isArray(body.player_ids) ? body.player_ids.map((id) => String(id).trim()) : (members || []).map((p) => String(p.id));
  if (requestedIds.length < 5 || requestedIds.length > 7) return invalid("В заявке должно быть от 5 до 7 игроков.", 409, "ROSTER_SIZE_INVALID");
  if (new Set(requestedIds).size !== requestedIds.length) return invalid("В составе есть повторяющиеся игроки.", 400, "ROSTER_DUPLICATE");
  if (requestedIds.some((id) => !memberIds.has(id))) return invalid("Можно выбрать только игроков из текущего состава команды с подтверждённым профилем.", 409, "ROSTER_MEMBER_INVALID");
  if (selectedSlot && selectedSlot.length < 2) return invalid("Укажи корректный временной слот.", 400, "INVALID_SLOT");
  const configuredSlots = String(tournament.registration_slots || "").split(/\r?\n/).map((slot) => slot.trim()).filter(Boolean).slice(0, 20);
  if (configuredSlots.length && !configuredSlots.includes(selectedSlot)) return invalid("Выбери один из временных слотов, указанных организатором.", 409, "SLOT_NOT_AVAILABLE");

  const existing = await env.DB.prepare(
    "SELECT * FROM tournament_registrations WHERE tournament_id=? AND team_id=?"
  ).bind(tournamentId, teamId).first();
  if (existing && !["rejected","withdrawn"].includes(existing.status)) return invalid("Эта команда уже подала заявку на турнир.", 409, "ALREADY_APPLIED");
  if (tournament.max_teams) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM tournament_registrations r JOIN teams capacity_team ON capacity_team.id=r.team_id AND capacity_team.status='active' AND capacity_team.archived_at IS NULL WHERE r.tournament_id=? AND r.status IN ('pending','approved')").bind(tournamentId).first();
    if ((count?.total || 0) >= tournament.max_teams) return invalid("Все места турнира уже заняты или ожидают подтверждения.", 409, "TOURNAMENT_FULL");
  }

  let registrationId = existing?.id ?? null;
  let reopenedExisting = false;
  try {
    if (existing) {
      const reopened = await env.DB.prepare(
        "UPDATE tournament_registrations SET status='pending',submitted_at=?,reviewed_at=NULL,reviewer_id=NULL,selected_slot=?,captain_note=?,updated_at=? WHERE id=? AND status IN ('rejected','withdrawn') AND (? IS NULL OR (SELECT COUNT(*) FROM tournament_registrations r JOIN teams capacity_team ON capacity_team.id=r.team_id AND capacity_team.status='active' AND capacity_team.archived_at IS NULL WHERE r.tournament_id=? AND r.status IN ('pending','approved')) < ?)"
      ).bind(now, selectedSlot || null, captainNote || null, now, existing.id, tournament.max_teams, tournamentId, tournament.max_teams).run();
      if (!reopened.meta?.changes) return invalid("Все места турнира уже заняты или заявка была изменена другим запросом.", 409, "TOURNAMENT_FULL");
      reopenedExisting = true;
    } else {
      const inserted = await env.DB.prepare(
        "INSERT INTO tournament_registrations (tournament_id,team_id,status,submitted_at,selected_slot,captain_note,updated_at) SELECT ?,?,'pending',?,?,?,? WHERE ? IS NULL OR (SELECT COUNT(*) FROM tournament_registrations r JOIN teams capacity_team ON capacity_team.id=r.team_id AND capacity_team.status='active' AND capacity_team.archived_at IS NULL WHERE r.tournament_id=? AND r.status IN ('pending','approved')) < ?"
      ).bind(tournamentId, teamId, now, selectedSlot || null, captainNote || null, now, tournament.max_teams, tournamentId, tournament.max_teams).run();
      if (!inserted.meta?.changes) return invalid("Все места турнира уже заняты или ожидают подтверждения.", 409, "TOURNAMENT_FULL");
      registrationId = inserted.meta?.last_row_id;
      if (registrationId == null) {
        const row = await env.DB.prepare("SELECT id FROM tournament_registrations WHERE tournament_id=? AND team_id=?").bind(tournamentId, teamId).first();
        registrationId = row?.id;
      }
    }
    if (registrationId == null) throw new Error("Registration ID was not returned");
    const writes = [];
    if (existing) writes.push(env.DB.prepare("DELETE FROM tournament_registration_roster WHERE registration_id=?").bind(registrationId));
    writes.push(...requestedIds.map((playerId) =>
      env.DB.prepare("INSERT INTO tournament_registration_roster (registration_id,player_id,roster_role,added_at) VALUES (?,?,?,?)")
        .bind(registrationId, playerId, requestedIds.indexOf(playerId) < 5 ? "starter" : "substitute", now)
    ));
    writes.push(
      env.DB.prepare("INSERT INTO notifications (user_id,type,title,message,link,entity_type,entity_id) VALUES (?,'application_submitted','Заявка отправлена',?,?, 'tournament',?)")
        .bind(auth.user.id, "Заявка команды " + team.name + " отправлена на рассмотрение.", "#/tournament/" + tournamentId, tournamentId),
      env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'tournament_application_submitted','tournament_registration',?,?)")
        .bind(await createAuditEventId(env.DB), auth.user.id, registrationId, JSON.stringify({ tournament_id: tournamentId, team_id: teamId, player_ids: requestedIds, selected_slot: selectedSlot || null }))
    );
    // Replacing the roster, writing the notification and audit record are atomic.
    await env.DB.batch(writes);
    return json({ data: { id: registrationId, tournament_id: tournamentId, team_id: teamId, team_name: team.name, team_tag: team.tag, player_ids: requestedIds, selected_slot: selectedSlot || null, status: "pending" } }, 201);
  } catch (error) {
    console.error("Tournament application failed", error);
    if (existing && reopenedExisting) {
      await env.DB.prepare(
        "UPDATE tournament_registrations SET status=?,submitted_at=?,reviewed_at=?,reviewer_id=?,selected_slot=?,captain_note=?,updated_at=? WHERE id=? AND status='pending' AND submitted_at=?"
      ).bind(existing.status, existing.submitted_at, existing.reviewed_at, existing.reviewer_id, existing.selected_slot, existing.captain_note, existing.updated_at, existing.id, now).run().catch((rollbackError) => console.error("Application reopen rollback failed:", rollbackError));
    } else if (!existing && registrationId != null) {
      await env.DB.prepare("DELETE FROM tournament_registrations WHERE id=? AND status='pending'").bind(registrationId).run().catch((rollbackError) => console.error("Application create rollback failed:", rollbackError));
    }
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      return invalid("Эта команда уже подала заявку на турнир.", 409, "ALREADY_APPLIED");
    }
    return invalid("Не удалось отправить заявку. Попробуй ещё раз.", 500, "APPLICATION_FAILED");
  }
}

export async function onRequestPut({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return invalid("Запрос отклонён.", 403, "ORIGIN_REJECTED");
  const auth = await currentUser(request, env);
  if (auth.response) return auth.response;
  let body;
  try { body = await request.json(); } catch { return invalid("Некорректные данные.", 400, "INVALID_JSON"); }
  const id = String(body.id || "").trim();
  const action = body.action;
  if (!id || !["withdraw"].includes(action)) return invalid("Некорректное действие.", 400);
  const row = await env.DB.prepare(
    "SELECT r.id,r.status,r.team_id,t.captain_id FROM tournament_registrations r JOIN teams t ON t.id=r.team_id WHERE r.id=?"
  ).bind(id).first();
  if (!row) return invalid("Заявка не найдена.", 404, "APPLICATION_NOT_FOUND");
  if (String(row.captain_id) !== String(auth.user.id)) return invalid("Отозвать заявку может только капитан команды.", 403, "FORBIDDEN");
  if (row.status !== "pending") return invalid("Можно отозвать только заявку на рассмотрении.", 409, "APPLICATION_NOT_PENDING");
  await env.DB.prepare("UPDATE tournament_registrations SET status='withdrawn',updated_at=? WHERE id=? AND status='pending'").bind(new Date().toISOString(), id).run();
  return json({ data: { id, status: "withdrawn" } });
}

export function onRequestDelete() { return methodNotAllowed("GET, POST, PUT"); }
