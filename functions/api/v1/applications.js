import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

async function currentUser(request, env) {
  if (!env.DB) return { response: databaseUnavailable() };
  const auth = await getSessionUser(request, env);
  if (auth.error) return { response: auth.error };
  if (!auth.user) return { response: json({ error: { code: "AUTH_REQUIRED", message: "Войди в аккаунт, чтобы подать заявку." } }, 401) };
  return { user: auth.user };
}

export async function onRequestGet({ request, env }) {
  const auth = await currentUser(request, env);
  if (auth.response) return auth.response;
  const { results } = await env.DB.prepare(
    "SELECT t.id,t.name,t.tag,t.region,r.id AS registration_id,r.status AS application_status FROM teams t LEFT JOIN tournament_registrations r ON r.team_id=t.id AND r.tournament_id=? WHERE t.captain_id=? AND t.status='active' ORDER BY t.name COLLATE NOCASE"
  ).bind(new URL(request.url).searchParams.get("tournament_id") || "", auth.user.id).all();
  return json({ data: results || [] });
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await currentUser(request, env);
  if (auth.response) return auth.response;
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Проверь данные заявки." } }, 400); }
  const tournamentId = String(body.tournament_id || "").trim();
  const teamId = String(body.team_id || "").trim();
  if (!tournamentId || !teamId) return json({ error: { code: "MISSING_FIELDS", message: "Выбери команду для участия." } }, 400);

  const tournament = await env.DB.prepare("SELECT id,title,status,max_teams,registration_open_at,registration_close_at FROM tournaments WHERE id=? AND published_at IS NOT NULL").bind(tournamentId).first();
  if (!tournament || tournament.status !== "published") return json({ error: { code: "REGISTRATION_CLOSED", message: "Регистрация на этот турнир сейчас закрыта." } }, 409);
  const now = new Date().toISOString();
  if (tournament.registration_open_at && now < tournament.registration_open_at) return json({ error: { code: "REGISTRATION_NOT_STARTED", message: "Регистрация ещё не началась." } }, 409);
  if (tournament.registration_close_at && now > tournament.registration_close_at) return json({ error: { code: "REGISTRATION_CLOSED", message: "Срок подачи заявок завершён." } }, 409);

  const team = await env.DB.prepare("SELECT id,name,tag FROM teams WHERE id=? AND captain_id=? AND status='active'").bind(teamId, auth.user.id).first();
  if (!team) return json({ error: { code: "TEAM_NOT_MANAGED", message: "Подать заявку может только капитан активной команды." } }, 403);

  const existing = await env.DB.prepare("SELECT id,status FROM tournament_registrations WHERE tournament_id=? AND team_id=?").bind(tournamentId, teamId).first();
  if (existing && existing.status !== "rejected" && existing.status !== "withdrawn") return json({ error: { code: "ALREADY_APPLIED", message: "Эта команда уже подала заявку на турнир." } }, 409);
  if (tournament.max_teams) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM tournament_registrations WHERE tournament_id=? AND status='approved'").bind(tournamentId).first();
    if ((count?.total || 0) >= tournament.max_teams) return json({ error: { code: "TOURNAMENT_FULL", message: "Свободных мест в турнире больше нет." } }, 409);
  }

  const id = crypto.randomUUID();
  try {
    if (existing) {
      await env.DB.prepare("UPDATE tournament_registrations SET status='pending',submitted_at=?,reviewed_at=NULL,reviewer_id=NULL WHERE id=?")
        .bind(now, existing.id).run();
    } else {
      await env.DB.prepare("INSERT INTO tournament_registrations (id,tournament_id,team_id,status,submitted_at) VALUES (?,?,?,'pending',?)")
        .bind(id, tournamentId, teamId, now).run();
    }
  } catch (error) {
    console.error("Tournament application failed", error);
    return json({ error: { code: "APPLICATION_FAILED", message: "Не удалось отправить заявку. Попробуй ещё раз." } }, 500);
  }
  return json({ data: { id: existing ? existing.id : id, tournament_id: tournamentId, team_id: teamId, team_name: team.name, team_tag: team.tag, status: "pending" } }, 201);
}

export function onRequestPut() { return methodNotAllowed("GET, POST"); }
export function onRequestDelete() { return methodNotAllowed("GET, POST"); }
