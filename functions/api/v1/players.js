import { createAuditEventId } from "./_lib/audit.js";
import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url, 50, 50);
  const playerId = url.searchParams.get("id");
  if (playerId) {
    const profile = await env.DB.prepare("SELECT p.id,p.nickname,p.game_id,p.role,p.team_id,p.region,p.avatar_url,p.created_at,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo,t.region AS team_region FROM players p LEFT JOIN teams t ON t.id=p.team_id AND t.status='active' AND t.archived_at IS NULL WHERE p.id=? AND p.profile_status='approved' AND p.archived_at IS NULL LIMIT 1").bind(playerId).first();
    if (!profile) return json({ data: [], limit: 1 });
    let stats = null;
    let recentMatches = [];
    try {
      stats = await env.DB.prepare(`
        SELECT COUNT(*) AS matches_played,
          COALESCE(SUM(CASE WHEN winner_team_id=team_id THEN 1 ELSE 0 END),0) AS wins,
          COALESCE(SUM(CASE WHEN winner_team_id IS NOT NULL AND winner_team_id!=team_id THEN 1 ELSE 0 END),0) AS losses,
          COALESCE(SUM(CASE WHEN winner_team_id=team_id THEN 3 ELSE 0 END),0) AS points,
          ROUND(100.0*SUM(CASE WHEN winner_team_id=team_id THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS win_rate
        FROM (
          SELECT DISTINCT m.id,m.winner_team_id,r.team_id
          FROM tournament_registration_roster rr
          JOIN tournament_registrations r ON r.id=rr.registration_id AND r.status='approved'
          JOIN matches m ON m.tournament_id=r.tournament_id
            AND (m.team_a_id=r.team_id OR m.team_b_id=r.team_id)
          WHERE rr.player_id=? AND rr.roster_role='starter'
            AND m.status='completed' AND m.result_verified_at IS NOT NULL
        )
      `).bind(playerId).first();
      const recentResult = await env.DB.prepare(`
        SELECT DISTINCT m.id,m.scheduled_at,m.updated_at,m.score_a,m.score_b,
          CASE WHEN m.winner_team_id=r.team_id THEN 'win' ELSE 'loss' END AS outcome,
          CASE WHEN m.team_a_id=r.team_id THEN m.score_a ELSE m.score_b END AS player_score,
          CASE WHEN m.team_a_id=r.team_id THEN m.score_b ELSE m.score_a END AS opponent_score,
          CASE WHEN m.team_a_id=r.team_id THEN tb.name ELSE ta.name END AS opponent_name,
          t.title AS tournament_title
        FROM tournament_registration_roster rr
        JOIN tournament_registrations r ON r.id=rr.registration_id AND r.status='approved'
        JOIN matches m ON m.tournament_id=r.tournament_id
          AND (m.team_a_id=r.team_id OR m.team_b_id=r.team_id)
        JOIN tournaments t ON t.id=m.tournament_id
        LEFT JOIN teams ta ON ta.id=m.team_a_id
        LEFT JOIN teams tb ON tb.id=m.team_b_id
        WHERE rr.player_id=? AND rr.roster_role='starter'
          AND m.status='completed' AND m.result_verified_at IS NOT NULL
        ORDER BY COALESCE(m.scheduled_at,m.updated_at) DESC,m.id DESC
        LIMIT 10
      `).bind(playerId).all();
      recentMatches = recentResult.results || [];
    } catch (error) {
      if (!/no such table:\s*tournament_registration_roster/i.test(String(error?.message || error))) throw error;
      console.warn("Player match history is unavailable until migration 0013 is applied.");
    }
    return json({ data: [{ ...profile, stats: {
      matches_played: stats?.matches_played || 0,
      wins: stats?.wins || 0,
      losses: stats?.losses || 0,
      points: stats?.points || 0,
      win_rate: stats?.win_rate || 0
    }, recent_matches: recentMatches || [] }], limit: 1 });
  }
  const query = (url.searchParams.get("query") || "").trim().slice(0, 80);
  const role = url.searchParams.get("role");
  const clauses = ["profile_status = 'approved'", "archived_at IS NULL"];
  const values = [];
  if (query) { clauses.push("(nickname LIKE ? OR game_id LIKE ?)"); values.push(`%${query}%`, `%${query}%`); }
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
  const manualReview = body.manual_review === true;
  const manualNickname = String(body.nickname || "").trim().replace(/\s+/g, " ").slice(0, 32);
  if (!/^\d{5,15}$/.test(gameId) || !/^\d{1,6}$/.test(serverId) || !["EXP", "JUNGLE", "MID", "GOLD", "ROAM", "FLEX"].includes(role)) return json({ error: { code: "INVALID_PROFILE", message: "Проверь MLBB ID, Server ID и игровую роль." } }, 400);
  if (manualReview && (manualNickname.length < 2 || manualNickname.length > 32)) return json({ error: { code: "INVALID_NICKNAME", message: "Укажи игровой ник длиной от 2 до 32 символов." } }, 400);
  const mlbb = manualReview ? { ok: true, nickname: manualNickname } : await lookupMlbbPlayer(env, gameId, serverId);
  if (!mlbb.ok) return json({ error: { code: mlbb.code, message: mlbb.message } }, mlbb.status);
  const profileStatus = manualReview ? "pending" : "approved";
  const profile = await env.DB.prepare("SELECT id FROM players WHERE user_id=? LIMIT 1").bind(session.user.id).first();
  const verifiedAt = new Date().toISOString();
  let playerId = profile?.id;
  try {
    if (profile) {
      await env.DB.prepare("UPDATE players SET nickname=?,game_id=?,server_id=?,mlbb_verified_at=?,role=?,region=?,profile_status=?,archived_at=NULL,updated_at=? WHERE user_id=?").bind(mlbb.nickname, gameId, serverId, manualReview ? null : verifiedAt, role, region || null, profileStatus, verifiedAt, session.user.id).run();
    } else {
      const inserted = await env.DB.prepare("INSERT INTO players (user_id,nickname,game_id,server_id,mlbb_verified_at,role,region,profile_status) VALUES (?,?,?,?,?,?,?,?)").bind(session.user.id, mlbb.nickname, gameId, serverId, manualReview ? null : verifiedAt, role, region || null, profileStatus).run();
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
  await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?, ?, ?, 'player', ?, ?)").bind(await createAuditEventId(env.DB), session.user.id, manualReview ? "player_profile_manual_review" : (profile ? "player_profile_reverified" : "player_profile_created"), String(playerId), JSON.stringify({ nickname: mlbb.nickname, game_id: gameId, server_id: serverId, role, region, profile_status: profileStatus, mlbb_verified: !manualReview, manual_review: manualReview })).run();
  return json({ data: { id: playerId, nickname: mlbb.nickname, game_id: gameId, server_id: serverId, role, region, profile_status: profileStatus, mlbb_verified_at: manualReview ? null : verifiedAt } });
}
