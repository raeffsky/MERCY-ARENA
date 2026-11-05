import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const playerId = url.searchParams.get("id");
  if (playerId) {
    const profile = await env.DB.prepare("SELECT p.id,p.nickname,p.game_id,p.role,p.team_id,p.region,p.avatar_url,p.created_at,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo,t.region AS team_region FROM players p LEFT JOIN teams t ON t.id=p.team_id AND t.status='active' WHERE p.id=? AND p.profile_status='approved' LIMIT 1").bind(playerId).first();
    return json({data:profile?[profile]:[],limit:1});
  }
  const query = (url.searchParams.get("query") || "").trim().slice(0, 80);
  const role = url.searchParams.get("role");
  const clauses = ["profile_status = 'approved'"];
  const values = [];
  if (query) { clauses.push("nickname LIKE ?"); values.push(`%${query}%`); }
  if (role) { clauses.push("role = ?"); values.push(role); }
  const { results } = await env.DB.prepare(`SELECT id,nickname,game_id,role,team_id,region,avatar_url,created_at FROM players WHERE ${clauses.join(" AND ")} ORDER BY nickname COLLATE NOCASE LIMIT ?`).bind(...values, limit).all();
  return json(publicList(results || [], limit));
}

export async function onRequestPut({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const { getSessionUser, sameOrigin } = await import("./_lib/session-auth.js");
  const { lookupMlbbPlayer } = await import("./_lib/mlbb-lookup.js");
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const session = await getSessionUser(request, env);
  if (session.error) return session.error;
  if (!session.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт, чтобы изменить профиль." } }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Некорректные данные." } }, 400); }
  const gameId = String(body.game_id || "").trim();
  const serverId = String(body.server_id || "").trim();
  const role = String(body.role || "");
  const region = String(body.region || "").trim().slice(0, 80);
  if (!/^\d{5,15}$/.test(gameId) || !/^\d{1,6}$/.test(serverId) || !["EXP", "JUNGLE", "MID", "GOLD", "ROAM", "FLEX"].includes(role)) return json({ error: { code: "INVALID_PROFILE", message: "Проверь MLBB ID, Server ID и игровую роль." } }, 400);
  const mlbb = await lookupMlbbPlayer(env, gameId, serverId);
  if (!mlbb.ok) return json({ error: { code: mlbb.code, message: mlbb.message } }, mlbb.status);
  const profile = await env.DB.prepare("SELECT id FROM players WHERE user_id=? LIMIT 1").bind(session.user.id).first();
  const verifiedAt = new Date().toISOString();
  let playerId = profile?.id;
  try {
    if (profile) {
      await env.DB.prepare("UPDATE players SET nickname=?,game_id=?,server_id=?,mlbb_verified_at=?,role=?,region=?,profile_status='approved',updated_at=? WHERE user_id=?").bind(mlbb.nickname, gameId, serverId, verifiedAt, role, region || null, verifiedAt, session.user.id).run();
    } else {
      const inserted = await env.DB.prepare("INSERT INTO players (user_id,nickname,game_id,server_id,mlbb_verified_at,role,region,profile_status) VALUES (?,?,?,?,?,?,?,'approved')").bind(session.user.id, mlbb.nickname, gameId, serverId, verifiedAt, role, region || null).run();
      playerId = Number(inserted.meta?.last_row_id);
      if (!Number.isSafeInteger(playerId) || playerId <= 0) return json({ error: { code: "PROFILE_CREATE_FAILED", message: "Не удалось создать игровой профиль. Попробуй ещё раз." } }, 500);
    }
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      return json({ error: { code: "GAME_ACCOUNT_IN_USE", message: "Этот игровой аккаунт уже привязан к другому профилю MERCY ARENA." } }, 409);
    }
    console.error("Player profile save failed:", error);
    return json({ error: { code: "PROFILE_SAVE_FAILED", message: "Не удалось сохранить игровой профиль. Попробуй позже." } }, 500);
  }
  await env.DB.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_json) VALUES (?, ?, 'player', ?, ?)").bind(session.user.id, profile ? "player_profile_reverified" : "player_profile_created", playerId, JSON.stringify({ nickname: mlbb.nickname, game_id: gameId, server_id: serverId, role, region, profile_status: "approved", mlbb_verified: true })).run();
  return json({ data: { id: playerId, nickname: mlbb.nickname, game_id: gameId, server_id: serverId, role, region, profile_status: "approved", mlbb_verified_at: verifiedAt } });
}
