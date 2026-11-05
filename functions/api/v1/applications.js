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

export async function onRequestGet({ request, env }) {
  const auth = await currentUser(request, env);
  if (auth.response) return auth.response;
  const tournamentId = new URL(request.url).searchParams.get("tournament_id") || "";
  const tournamentConfig = await env.DB.prepare("SELECT registration_slots FROM tournaments WHERE id=?").bind(tournamentId).first();
  const availableSlots = String(tournamentConfig?.registration_slots || "").split(/\r?\n/).map((slot) => slot.trim()).filter(Boolean).slice(0, 20);
  const { results } = await env.DB.prepare(
    `SELECT t.id,t.name,t.tag,t.region,r.id AS registration_id,r.status AS application_status,
      r.selected_slot,r.captain_note,r.submitted_at,r.reviewed_at,
      (SELECT COUNT(*) FROM team_roster tr WHERE tr.team_id=t.id AND tr.left_at IS NULL) AS roster_count
     FROM teams t
     LEFT JOIN tournament_registrations r ON r.team_id=t.id AND r.tournament_id=?
     WHERE t.captain_id=? AND t.status='active'
     ORDER BY t.name COLLATE NOCASE`
  ).bind(tournamentId, auth.user.id).all();
  const rows = results || [];
  for (const row of rows) {
    const available = await env.DB.prepare(
      `SELECT p.id,p.nickname,p.role,p.game_id,p.server_id,
        CASE WHEN p.user_id=t.captain_id THEN 'captain' ELSE COALESCE(tr.roster_role,'player') END AS team_role
       FROM team_roster tr JOIN players p ON p.id=tr.player_id JOIN teams t ON t.id=tr.team_id
       WHERE tr.team_id=? AND tr.left_at IS NULL AND p.profile_status='approved'
       ORDER BY CASE WHEN p.user_id=t.captain_id THEN 0 ELSE 1 END,p.nickname COLLATE NOCASE`
    ).bind(row.id).all();
    row.available_players = available.results || [];
    row.available_slots = availableSlots;
    if (!row.registration_id) { row.roster = []; continue; }
    const roster = await env.DB.prepare(
      `SELECT p.id,p.nickname,p.role,p.game_id,p.server_id,rr.roster_role
       FROM tournament_registration_roster rr JOIN players p ON p.id=rr.player_id
       WHERE rr.registration_id=?
       ORDER BY CASE rr.roster_role WHEN 'starter' THEN 0 ELSE 1 END,p.nickname COLLATE NOCASE`
    ).bind(row.registration_id).all();
    row.roster = roster.results || [];
  }
  return json({ data: rows });
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

  const tournament = await env.DB.prepare(
    "SELECT id,title,status,max_teams,registration_open_at,registration_close_at,registration_slots FROM tournaments WHERE id=? AND published_at IS NOT NULL"
  ).bind(tournamentId).first();
  if (!tournament || tournament.status !== "published") return invalid("Регистрация на этот турнир сейчас закрыта.", 409, "REGISTRATION_CLOSED");
  const now = new Date().toISOString();
  if (tournament.registration_open_at && now < tournament.registration_open_at) return invalid("Регистрация ещё не началась.", 409, "REGISTRATION_NOT_STARTED");
  if (tournament.registration_close_at && now > tournament.registration_close_at) return invalid("Срок подачи заявок завершён.", 409, "REGISTRATION_CLOSED");

  const team = await env.DB.prepare(
    "SELECT id,name,tag FROM teams WHERE id=? AND captain_id=? AND status='active'"
  ).bind(teamId, auth.user.id).first();
  if (!team) return invalid("Подать заявку может только капитан активной команды.", 403, "TEAM_NOT_MANAGED");

  const { results: members } = await env.DB.prepare(
    `SELECT p.id,p.nickname,p.role FROM team_roster tr
     JOIN players p ON p.id=tr.player_id
     WHERE tr.team_id=? AND tr.left_at IS NULL AND p.profile_status='approved'
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
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM tournament_registrations WHERE tournament_id=? AND status IN ('pending','approved')").bind(tournamentId).first();
    if ((count?.total || 0) >= tournament.max_teams) return invalid("Все места турнира уже заняты или ожидают подтверждения.", 409, "TOURNAMENT_FULL");
  }

  let registrationId = existing?.id ?? null;
  let reopenedExisting = false;
  try {
    if (existing) {
      const reopened = await env.DB.prepare(
        "UPDATE tournament_registrations SET status='pending',submitted_at=?,reviewed_at=NULL,reviewer_id=NULL,selected_slot=?,captain_note=?,updated_at=? WHERE id=? AND status IN ('rejected','withdrawn') AND (? IS NULL OR (SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id=? AND status IN ('pending','approved')) < ?)"
      ).bind(now, selectedSlot || null, captainNote || null, now, existing.id, tournament.max_teams, tournamentId, tournament.max_teams).run();
      if (!reopened.meta?.changes) return invalid("Все места турнира уже заняты или заявка была изменена другим запросом.", 409, "TOURNAMENT_FULL");
      reopenedExisting = true;
    } else {
      const inserted = await env.DB.prepare(
        "INSERT INTO tournament_registrations (tournament_id,team_id,status,submitted_at,selected_slot,captain_note,updated_at) SELECT ?,?,'pending',?,?,?,? WHERE ? IS NULL OR (SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id=? AND status IN ('pending','approved')) < ?"
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
      env.DB.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_json) VALUES (?,'tournament_application_submitted','tournament_registration',?,?)")
        .bind(auth.user.id, registrationId, JSON.stringify({ tournament_id: tournamentId, team_id: teamId, player_ids: requestedIds, selected_slot: selectedSlot || null }))
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
