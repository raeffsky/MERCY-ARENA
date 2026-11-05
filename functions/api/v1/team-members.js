import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user) return json({ data: [] });
  const url = new URL(request.url);
  const teamIdValue = url.searchParams.get("team_id");
  if (!teamIdValue) {
    const player = await env.DB.prepare("SELECT id FROM players WHERE user_id=? AND profile_status='approved' LIMIT 1").bind(auth.user.id).first();
    if (!player) return json({ data: [] });
    const { results } = await env.DB.prepare("SELECT i.id,i.team_id,i.status,i.created_at,t.name AS team_name,t.tag AS team_tag,p.nickname AS captain_name FROM team_invites i JOIN teams t ON t.id=i.team_id LEFT JOIN players p ON p.user_id=t.captain_id WHERE i.player_id=? AND i.status='pending' ORDER BY i.created_at DESC").bind(player.id).all();
    return json({ data: results || [] });
  }
  const teamId = String(teamIdValue || "").trim();
  if (!teamId) return json({ error: { code: "INVALID_TEAM", message: "Укажи команду." } }, 400);
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
  if (body.action === "transfer_captain") {
    const teamId = String(body.team_id || "").trim(), nextPlayerId = String(body.new_captain_player_id || "").trim();
    if (!teamId || !nextPlayerId) return json({ error: { code: "INVALID_TRANSFER", message: "Укажи команду и нового капитана." } }, 400);
    const team = await env.DB.prepare("SELECT id,captain_id FROM teams WHERE id=? AND captain_id=? AND status='active'").bind(teamId, auth.user.id).first();
    if (!team) return json({ error: { code: "CAPTAIN_REQUIRED", message: "Передать капитанство может только текущий капитан." } }, 403);
    const member = await env.DB.prepare("SELECT p.id,p.user_id,p.nickname FROM team_roster r JOIN players p ON p.id=r.player_id WHERE r.team_id=? AND r.player_id=? AND r.left_at IS NULL AND p.profile_status='approved'").bind(teamId, nextPlayerId).first();
    if (!member) return json({ error: { code: "MEMBER_NOT_FOUND", message: "Новый капитан должен состоять в команде." } }, 404);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE teams SET captain_id=?,updated_at=? WHERE id=? AND captain_id=?").bind(member.user_id, now, teamId, auth.user.id),
      env.DB.prepare("UPDATE team_roster SET roster_role=CASE WHEN player_id=? THEN 'captain' WHEN roster_role='captain' THEN 'player' ELSE roster_role END WHERE team_id=? AND left_at IS NULL").bind(nextPlayerId, teamId),
      env.DB.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_json) VALUES (?,'team_captain_transferred','team',?,?)").bind(auth.user.id, teamId, JSON.stringify({ new_captain_player_id: nextPlayerId, new_captain_user_id: member.user_id, nickname: member.nickname }))
    ]);
    return json({ data: { team_id: teamId, captain_player_id: nextPlayerId, captain_name: member.nickname, status: "transferred" } });
  }
  const teamId = String(body.team_id || "").trim(), playerId = String(body.player_id || "").trim();
  if (!teamId || !playerId) return json({ error: { code: "INVALID_INVITE", message: "Проверь команду и игрока." } }, 400);
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
    env.DB.prepare("INSERT INTO team_roster (team_id,player_id,roster_role,joined_at,left_at) VALUES (?,?,'player',?,NULL) ON CONFLICT(team_id,player_id) DO UPDATE SET roster_role='player',joined_at=excluded.joined_at,left_at=NULL").bind(invite.team_id, player.id, now),
    env.DB.prepare("UPDATE players SET team_id=?,updated_at=? WHERE id=? AND team_id IS NULL").bind(invite.team_id, now, player.id)
  ]);
  return json({ data: { team_id: invite.team_id, team_name: invite.team_name, status: "accepted" } });
}
export async function onRequestDelete({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт." } }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Некорректные данные." } }, 400); }
  const teamId = String(body.team_id || "").trim(), playerId = String(body.player_id || "").trim();
  if (!teamId || !playerId) return json({ error: { code: "INVALID_MEMBER", message: "Укажи команду и игрока." } }, 400);
  const team = await env.DB.prepare("SELECT id,captain_id FROM teams WHERE id=? AND status='active'").bind(teamId).first();
  if (!team) return json({ error: { code: "TEAM_NOT_FOUND", message: "Команда не найдена." } }, 404);
  const member = await env.DB.prepare("SELECT r.roster_role,p.user_id FROM team_roster r JOIN players p ON p.id=r.player_id WHERE r.team_id=? AND r.player_id=? AND r.left_at IS NULL").bind(teamId, playerId).first();
  if (!member) return json({ error: { code: "MEMBER_NOT_FOUND", message: "Игрок не состоит в этой команде." } }, 404);
  const isCaptain = String(team.captain_id) === String(auth.user.id);
  const isSelf = String(member.user_id) === String(auth.user.id);
  if (!isCaptain && !isSelf) return json({ error: { code: "FORBIDDEN", message: "Изменять состав может капитан команды или сам игрок при выходе." } }, 403);
  if (member.roster_role === "captain") return json({ error: { code: "CAPTAIN_CANNOT_LEAVE", message: "Капитан не может покинуть команду. Сначала передай руководство." } }, 409);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE team_roster SET left_at=? WHERE team_id=? AND player_id=? AND left_at IS NULL").bind(now, teamId, playerId),
    env.DB.prepare("UPDATE players SET team_id=NULL,updated_at=? WHERE id=? AND team_id=?").bind(now, playerId, teamId),
    env.DB.prepare("UPDATE team_invites SET status='cancelled',responded_at=? WHERE team_id=? AND player_id=? AND status='pending'").bind(now, teamId, playerId)
  ]);
  return json({ data: { team_id: teamId, player_id: playerId, status: "removed" } });
}
