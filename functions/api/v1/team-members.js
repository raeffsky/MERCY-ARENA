import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user) return json({ data: [] });
  const teamId = Number(new URL(request.url).searchParams.get("team_id"));
  if (!Number.isSafeInteger(teamId) || teamId < 1) return json({ error: { code: "INVALID_TEAM", message: "Укажи команду." } }, 400);
  const own = await env.DB.prepare("SELECT id FROM teams WHERE id=? AND captain_id=?").bind(teamId, auth.user.id).first();
  if (!own) return json({ data: [] });
  const { results } = await env.DB.prepare("SELECT i.id,i.status,i.created_at,p.id AS player_id,p.nickname,p.role,p.avatar_url FROM team_invites i JOIN players p ON p.id=i.player_id WHERE i.team_id=? AND i.status='pending' ORDER BY i.created_at DESC").bind(teamId).all();
  return json({ data: results || [] });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт." } }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Некорректные данные." } }, 400); }
  const teamId = Number(body.team_id), playerId = Number(body.player_id);
  if (!Number.isSafeInteger(teamId) || teamId < 1 || !Number.isSafeInteger(playerId) || playerId < 1) return json({ error: { code: "INVALID_INVITE", message: "Проверь команду и игрока." } }, 400);
  const team = await env.DB.prepare("SELECT id FROM teams WHERE id=? AND captain_id=? AND status='active'").bind(teamId, auth.user.id).first();
  if (!team) return json({ error: { code: "CAPTAIN_REQUIRED", message: "Приглашать игроков может только капитан." } }, 403);
  const player = await env.DB.prepare("SELECT id,team_id,profile_status FROM players WHERE id=?").bind(playerId).first();
  if (!player || player.profile_status !== "approved") return json({ error: { code: "PLAYER_NOT_AVAILABLE", message: "Игрок не найден или профиль не подтверждён." } }, 404);
  if (player.team_id) return json({ error: { code: "PLAYER_IN_TEAM", message: "Этот игрок уже состоит в команде." } }, 409);
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM team_roster WHERE team_id=? AND left_at IS NULL").bind(teamId).first();
  if ((count?.total || 0) >= 7) return json({ error: { code: "ROSTER_FULL", message: "В составе уже 7 игроков." } }, 409);
  const old = await env.DB.prepare("SELECT id,status FROM team_invites WHERE team_id=? AND player_id=?").bind(teamId, playerId).first();
  if (old?.status === "pending" || old?.status === "accepted") return json({ error: { code: "INVITE_EXISTS", message: "Приглашение уже существует." } }, 409);
  const now = new Date().toISOString();
  if (old) await env.DB.prepare("UPDATE team_invites SET status='pending',invited_by=?,created_at=?,responded_at=NULL WHERE id=?").bind(auth.user.id, now, old.id).run();
  else await env.DB.prepare("INSERT INTO team_invites (team_id,player_id,invited_by,status,created_at) VALUES (?,?,?,'pending',?)").bind(teamId, playerId, auth.user.id, now).run();
  return json({ data: { team_id: teamId, player_id: playerId, status: "pending" } }, 201);
}

export async function onRequestPut({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт." } }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Некорректные данные." } }, 400); }
  const inviteId = Number(body.invite_id), action = body.action;
  if (!Number.isSafeInteger(inviteId) || inviteId < 1 || !["accept","decline"].includes(action)) return json({ error: { code: "INVALID_ACTION", message: "Некорректное действие." } }, 400);
  const player = await env.DB.prepare("SELECT id,team_id FROM players WHERE user_id=? AND profile_status='approved'").bind(auth.user.id).first();
  if (!player) return json({ error: { code: "PROFILE_REQUIRED", message: "Нужен подтверждённый игровой профиль." } }, 409);
  const invite = await env.DB.prepare("SELECT i.*,t.name AS team_name FROM team_invites i JOIN teams t ON t.id=i.team_id WHERE i.id=? AND i.player_id=? AND i.status='pending'").bind(inviteId, player.id).first();
  if (!invite) return json({ error: { code: "INVITE_NOT_FOUND", message: "Приглашение не найдено или уже обработано." } }, 404);
  const now = new Date().toISOString();
  if (action === "decline") {
    await env.DB.prepare("UPDATE team_invites SET status='declined',responded_at=? WHERE id=? AND status='pending'").bind(now, inviteId).run();
    return json({ data: { status: "declined" } });
  }
  if (player.team_id) return json({ error: { code: "ALREADY_IN_TEAM", message: "Ты уже состоишь в команде." } }, 409);
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM team_roster WHERE team_id=? AND left_at IS NULL").bind(invite.team_id).first();
  if ((count?.total || 0) >= 7) return json({ error: { code: "ROSTER_FULL", message: "В составе больше нет свободных мест." } }, 409);
  await env.DB.batch([
    env.DB.prepare("UPDATE team_invites SET status='accepted',responded_at=? WHERE id=? AND status='pending'").bind(now, inviteId),
    env.DB.prepare("INSERT INTO team_roster (team_id,player_id,roster_role,joined_at) VALUES (?,?,'player',?)").bind(invite.team_id, player.id, now),
    env.DB.prepare("UPDATE players SET team_id=?,updated_at=? WHERE id=? AND team_id IS NULL").bind(invite.team_id, now, player.id)
  ]);
  return json({ data: { team_id: invite.team_id, team_name: invite.team_name, status: "accepted" } });
}
export function onRequestDelete() { return methodNotAllowed("GET, POST, PUT"); }
