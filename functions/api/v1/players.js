import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const playerId = url.searchParams.get("id");
  if (playerId && /^\d+$/.test(playerId)) {
    const profile = await env.DB.prepare("SELECT p.id,p.nickname,p.game_id,p.role,p.team_id,p.region,p.created_at,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo,t.region AS team_region FROM players p LEFT JOIN teams t ON t.id=p.team_id AND t.status='active' WHERE p.id=? AND p.profile_status='approved' LIMIT 1").bind(Number(playerId)).first();
    return json({data:profile?[profile]:[],limit:1});
  }
  const query = (url.searchParams.get("query") || "").trim().slice(0, 80);
  const role = url.searchParams.get("role");
  const clauses = ["profile_status = 'approved'"];
  const values = [];
  if (query) { clauses.push("nickname LIKE ?"); values.push(`%${query}%`); }
  if (role) { clauses.push("role = ?"); values.push(role); }
  const { results } = await env.DB.prepare(`SELECT id,nickname,game_id,role,team_id,region,created_at FROM players WHERE ${clauses.join(" AND ")} ORDER BY nickname COLLATE NOCASE LIMIT ?`).bind(...values, limit).all();
  return json(publicList(results || [], limit));
}

export async function onRequestPut({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const { getSessionUser, sameOrigin } = await import("./_lib/session-auth.js");
  if (!request.headers.get("origin") || !sameOrigin(request,env)) return json({error:{code:"ORIGIN_REJECTED",message:"Запрос отклонён."}},403);
  const session=await getSessionUser(request,env);
  if(session.error)return session.error;
  if(!session.user)return json({error:{code:"UNAUTHORIZED",message:"Войди в аккаунт, чтобы изменить профиль."}},401);
  let body;try{body=await request.json()}catch{return json({error:{code:"INVALID_JSON",message:"Некорректные данные."}},400)}
  const nickname=String(body.nickname||"").trim().slice(0,32),gameId=String(body.game_id||"").trim().slice(0,40),role=String(body.role||""),region=String(body.region||"").trim().slice(0,80);
  if(nickname.length<2||!gameId||!/^[0-9-]{5,40}$/.test(gameId)||!["EXP","JUNGLE","MID","GOLD","ROAM","FLEX"].includes(role))return json({error:{code:"INVALID_PROFILE",message:"Проверь ник, игровой ID и роль."}},400);
  const profile=await env.DB.prepare("SELECT id FROM players WHERE user_id=?").bind(session.user.id).first();
  let playerId=profile?.id;
  if(profile){
    await env.DB.prepare("UPDATE players SET nickname=?,game_id=?,role=?,region=?,profile_status='pending',updated_at=? WHERE user_id=?").bind(nickname,gameId,role,region||null,new Date().toISOString(),session.user.id).run();
  }else{
    const inserted=await env.DB.prepare("INSERT INTO players (user_id,nickname,game_id,role,region,profile_status) VALUES (?,?,?,?,?,'pending')").bind(session.user.id,nickname,gameId,role,region||null).run();
    playerId=Number(inserted.meta?.last_row_id);
    if(!Number.isSafeInteger(playerId)||playerId<=0)return json({error:{code:"PROFILE_CREATE_FAILED",message:"Не удалось создать игровой профиль. Попробуй ещё раз."}},500);
  }
  await env.DB.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'player',?,?)").bind(session.user.id,profile?'player_profile_updated':'player_profile_created',playerId,JSON.stringify({nickname,role,region,profile_status:"pending"})).run();
  return json({data:{id:playerId,nickname,profile_status:"pending"}});
}
