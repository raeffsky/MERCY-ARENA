import { createAuditEventId } from "./_lib/audit.js";
import { json, databaseUnavailable, parseLimit, publicList, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url), limit = parseLimit(url, 50, 50);
  const teamId = url.searchParams.get("id");
  if (teamId) {
    const viewer = await getSessionUser(request, env);
    const team = await env.DB.prepare("SELECT t.id,t.name,t.tag,t.logo_url,t.region,t.status,t.created_at,t.captain_id,p.nickname AS captain_name FROM teams t LEFT JOIN players p ON p.user_id=t.captain_id WHERE t.id=? AND t.status='active' LIMIT 1").bind(teamId).first();
    if (!team) return json({ data: [] });
    const { results } = await env.DB.prepare("SELECT id,nickname,role,avatar_url,region,roster_role,joined_at FROM (SELECT p.id,p.nickname,p.role,p.avatar_url,p.region,CASE WHEN p.user_id=t.captain_id THEN 'captain' ELSE COALESCE(r.roster_role,'player') END AS roster_role,COALESCE(r.joined_at,p.created_at) AS joined_at,ROW_NUMBER() OVER (PARTITION BY COALESCE(p.game_id,'profile-'||p.id)||':'||COALESCE(p.server_id,'') ORDER BY CASE WHEN p.user_id=t.captain_id THEN 0 ELSE 1 END,CASE WHEN p.avatar_url IS NOT NULL THEN 0 ELSE 1 END,p.created_at DESC) AS profile_rank FROM players p JOIN teams t ON t.id=p.team_id LEFT JOIN team_roster r ON r.team_id=t.id AND r.player_id=p.id AND r.left_at IS NULL WHERE t.id=? AND p.profile_status='approved') WHERE profile_rank=1 ORDER BY CASE roster_role WHEN 'captain' THEN 0 WHEN 'player' THEN 1 ELSE 2 END,nickname COLLATE NOCASE LIMIT 7").bind(teamId).all();
    const stats = await env.DB.prepare("SELECT COUNT(*) AS matches_played,SUM(CASE WHEN winner_team_id=? THEN 1 ELSE 0 END) AS wins,SUM(CASE WHEN winner_team_id IS NOT NULL AND winner_team_id!=? THEN 1 ELSE 0 END) AS losses FROM matches WHERE (team_a_id=? OR team_b_id=?) AND status='completed' AND result_verified_at IS NOT NULL").bind(teamId,teamId,teamId,teamId).first();
    const { results: tournaments } = await env.DB.prepare("SELECT tr.status,tr.submitted_at,t.id AS tournament_id,t.title,t.starts_at,t.format FROM tournament_registrations tr JOIN tournaments t ON t.id=tr.tournament_id WHERE tr.team_id=? ORDER BY tr.submitted_at DESC LIMIT 5").bind(teamId).all();
    return json({ data: [{ ...team, is_captain: Boolean(viewer.user && String(viewer.user.id) === String(team.captain_id)), roster: results || [], stats: { matches_played: stats?.matches_played || 0, wins: stats?.wins || 0, losses: stats?.losses || 0 }, tournaments: tournaments || [] }] });
  }
  const query = (url.searchParams.get("query") || "").trim().slice(0, 80);
  const { results } = await env.DB.prepare("SELECT id,name,tag,logo_url,region,status,created_at FROM teams WHERE status='active' AND (?='' OR name LIKE ? OR tag LIKE ?) ORDER BY name COLLATE NOCASE LIMIT ?").bind(query, `%${query}%`, `%${query}%`, limit).all();
  return json(publicList(results || [], limit));
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт, чтобы создать команду." } }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Проверь данные команды." } }, 400); }
  const name = String(body.name || "").trim().slice(0, 40);
  const tag = String(body.tag || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const region = String(body.region || "").trim().slice(0, 80);
  if (name.length < 3 || tag.length < 2) return json({ error: { code: "INVALID_TEAM", message: "Название должно содержать от 3 символов, тег от 2 до 5 латинских букв или цифр." } }, 400);
  const player = await env.DB.prepare("SELECT id,team_id FROM players WHERE user_id=? AND profile_status='approved' LIMIT 1").bind(auth.user.id).first();
  if (!player) return json({ error: { code: "APPROVED_PROFILE_REQUIRED", message: "Сначала создай и подтверди игровой профиль." } }, 409);
  if (player.team_id) return json({ error: { code: "ALREADY_IN_TEAM", message: "Сначала выйди из текущей команды." } }, 409);
  const now = new Date().toISOString();
  let createdTeamId = null;
  try {
    const inserted = await env.DB.prepare("INSERT INTO teams (name,tag,captain_id,region,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").bind(name, tag, auth.user.id, region || null, now, now).run();
    const teamId = Number(inserted.meta?.last_row_id);
    if (!Number.isSafeInteger(teamId) || teamId < 1) throw new Error("Team ID was not returned");
    createdTeamId = teamId;
    const membership = await env.DB.batch([
      env.DB.prepare("UPDATE players SET team_id=?,updated_at=? WHERE id=? AND team_id IS NULL").bind(teamId, now, player.id),
      env.DB.prepare("INSERT INTO team_roster (team_id,player_id,roster_role,joined_at) SELECT ?,id,'captain',? FROM players WHERE id=? AND team_id=?").bind(teamId, now, player.id, teamId),
      env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) SELECT ?,?,'team_created','team',?,? FROM players WHERE id=? AND team_id=?").bind(await createAuditEventId(env.DB), auth.user.id, teamId, JSON.stringify({ name, tag, region, captain_player_id: player.id }), player.id, teamId)
    ]);
    if (!membership[0]?.meta?.changes) {
      await env.DB.prepare("DELETE FROM teams WHERE id=? AND captain_id=?").bind(teamId, auth.user.id).run();
      return json({ error: { code: "ALREADY_IN_TEAM", message: "Игрок уже вступил в другую команду. Обнови страницу." } }, 409);
    }
    if (!membership[1]?.meta?.changes) throw new Error("Captain roster entry was not created");
    return json({ data: { id: teamId, name, tag, region, captain_id: auth.user.id, roster: [{ player_id: player.id, roster_role: "captain" }] } }, 201);
  } catch (error) {
    console.error("Team creation failed:", error);
    if (createdTeamId !== null) {
      await env.DB.batch([
        env.DB.prepare("UPDATE players SET team_id=NULL,updated_at=? WHERE id=? AND team_id=?").bind(new Date().toISOString(), player.id, createdTeamId),
        env.DB.prepare("DELETE FROM teams WHERE id=? AND captain_id=?").bind(createdTeamId, auth.user.id)
      ]).catch((cleanupError) => console.error("Team creation rollback failed:", cleanupError));
    }
    if (/UNIQUE constraint failed/i.test(String(error.message))) return json({ error: { code: "TEAM_TAG_TAKEN", message: "Этот тег уже занят. Выбери другой." } }, 409);
    return json({ error: { code: "TEAM_CREATE_FAILED", message: "Не удалось создать команду. Попробуй ещё раз." } }, 500);
  }
}
export function onRequestPut() { return methodNotAllowed("GET, POST"); }
export function onRequestDelete() { return methodNotAllowed("GET, POST"); }
