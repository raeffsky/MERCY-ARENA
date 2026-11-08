import { json, databaseUnavailable, parseLimit } from "./_lib/http.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";
import { createAuditEventId } from "./_lib/audit.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const limit = parseLimit(new URL(request.url), 12, 50);
  const current = await env.DB.prepare("SELECT r.id,r.team_id,r.started_at,r.defenses_count,r.notes,t.name AS team_name,t.tag AS team_tag,t.logo_url,t.region,t.captain_id FROM mercy_crown_reigns r JOIN teams t ON t.id=r.team_id WHERE r.ended_at IS NULL LIMIT 1").first();
  const history = await env.DB.prepare("SELECT r.id,r.team_id,r.started_at,r.ended_at,r.defenses_count,r.end_reason,t.name AS team_name,t.tag AS team_tag,t.logo_url FROM mercy_crown_reigns r JOIN teams t ON t.id=r.team_id WHERE r.ended_at IS NOT NULL ORDER BY r.ended_at DESC,r.id DESC LIMIT ?").bind(limit).all();
  const challenges = await env.DB.prepare("SELECT c.id,c.challenger_team_id,c.status,c.message,c.created_at,t.name AS team_name,t.tag AS team_tag,t.logo_url FROM mercy_crown_challenges c JOIN teams t ON t.id=c.challenger_team_id WHERE c.status IN ('pending','accepted','scheduled') ORDER BY c.created_at ASC LIMIT ?").bind(limit).all();
  return json({data:{current:current||null,history:history.results||[],challenges:challenges.results||[]}});
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request,env)) return json({error:{code:"ORIGIN_REJECTED",message:"Запрос отклонён."}},403);
  const session=await getSessionUser(request,env);
  if(session.error)return session.error;
  if(!session.user)return json({error:{code:"UNAUTHORIZED",message:"Войди в аккаунт MERCY ARENA."}},401);
  let body; try{body=await request.json()}catch{return json({error:{code:"INVALID_JSON",message:"Некорректные данные."}},400)}
  if(body.action==="challenge_decision"){
    const challengeId=Number(body.challenge_id),decision=String(body.decision||"");
    if(!Number.isSafeInteger(challengeId)||challengeId<=0||!["accept","decline"].includes(decision))return json({error:{code:"INVALID_DECISION",message:"Некорректное решение по вызову."}},400);
    const current=await env.DB.prepare("SELECT t.captain_id FROM mercy_crown_reigns r JOIN teams t ON t.id=r.team_id WHERE r.ended_at IS NULL LIMIT 1").first();
    const owner=session.user.roles.includes("administrator")&&isOwnerAccount(session.user,env);
    if(!current||(String(current.captain_id)!==String(session.user.id)&&!owner))return json({error:{code:"FORBIDDEN",message:"Решение по вызову принимает чемпион или владелец платформы."}},403);
    const challenge=await env.DB.prepare("SELECT id,status FROM mercy_crown_challenges WHERE id=? LIMIT 1").bind(challengeId).first();
    if(!challenge||challenge.status!=="pending")return json({error:{code:"CHALLENGE_NOT_PENDING",message:"Этот вызов уже обработан."}},409);
    await env.DB.prepare("UPDATE mercy_crown_challenges SET status=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),decided_by=? WHERE id=? AND status='pending'").bind(decision==="accept"?"accepted":"declined",session.user.id,challengeId).run();
    await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?,?)").bind(await createAuditEventId(env.DB),session.user.id,"mercy_crown_challenge_"+decision,"mercy_crown_challenge",String(challengeId),JSON.stringify({decision})).run();
    return json({data:{id:challengeId,status:decision==="accept"?"accepted":"declined"}});
  }
  if(body.action==="challenge"){
    const teamId=Number(body.team_id),message=String(body.message||"").trim().slice(0,500);
    if(!Number.isSafeInteger(teamId)||teamId<=0)return json({error:{code:"INVALID_TEAM",message:"Выбери команду."}},400);
    const team=await env.DB.prepare("SELECT id,captain_id,status FROM teams WHERE id=? LIMIT 1").bind(teamId).first();
    if(!team||team.status!=="active")return json({error:{code:"TEAM_NOT_FOUND",message:"Активная команда не найдена."}},404);
    const owner=session.user.roles.includes("administrator")&&isOwnerAccount(session.user,env);
    if(String(team.captain_id)!==String(session.user.id)&&!owner)return json({error:{code:"FORBIDDEN",message:"Вызов может отправить капитан команды."}},403);
    const champ=await env.DB.prepare("SELECT team_id FROM mercy_crown_reigns WHERE ended_at IS NULL LIMIT 1").first();
    if(champ&&String(champ.team_id)===String(teamId))return json({error:{code:"ALREADY_CHAMPION",message:"Чемпион не может вызвать сам себя."}},409);
    const pending=await env.DB.prepare("SELECT id FROM mercy_crown_challenges WHERE challenger_team_id=? AND status IN ('pending','accepted','scheduled') LIMIT 1").bind(teamId).first();
    if(pending)return json({error:{code:"CHALLENGE_EXISTS",message:"У команды уже есть активный вызов."}},409);
    const result=await env.DB.prepare("INSERT INTO mercy_crown_challenges (challenger_team_id,requested_by,message) VALUES (?,?,?)").bind(teamId,session.user.id,message||null).run();
    return json({data:{id:Number(result.meta?.last_row_id),status:"pending"}},201);
  }
  if(body.action==="record_result"){
    if(!session.user.roles.includes("administrator")||!isOwnerAccount(session.user,env))return json({error:{code:"FORBIDDEN",message:"Только администратор-владелец может зафиксировать результат."}},403);
    const matchId=Number(body.match_id);
    if(!Number.isSafeInteger(matchId)||matchId<=0)return json({error:{code:"INVALID_MATCH",message:"Укажи ID матча."}},400);
    const match=await env.DB.prepare("SELECT id,team_a_id,team_b_id,winner_team_id,status,result_verified_at FROM matches WHERE id=? LIMIT 1").bind(matchId).first();
    if(!match||match.status!=="completed"||!match.result_verified_at||!match.winner_team_id)return json({error:{code:"MATCH_NOT_VERIFIED",message:"Нужен завершённый матч с подтверждённым результатом."}},409);
    const current=await env.DB.prepare("SELECT * FROM mercy_crown_reigns WHERE ended_at IS NULL LIMIT 1").first(),winner=Number(match.winner_team_id);
    if(current&&winner===Number(current.team_id)){
      const challenge=await env.DB.prepare("SELECT id FROM mercy_crown_challenges WHERE challenger_team_id IN (?,?) AND status IN ('pending','accepted','scheduled') ORDER BY created_at LIMIT 1").bind(match.team_a_id,match.team_b_id).first();
      if(!challenge)return json({error:{code:"NO_TITLE_CHALLENGE",message:"Для защиты нужен зарегистрированный вызов соперника."}},409);
      await env.DB.prepare("UPDATE mercy_crown_reigns SET defenses_count=defenses_count+1 WHERE id=?").bind(current.id).run();
      await env.DB.prepare("UPDATE mercy_crown_challenges SET status='completed',result_match_id=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),decided_by=? WHERE id=?").bind(matchId,session.user.id,challenge.id).run();
      await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?,?)").bind(await createAuditEventId(env.DB),session.user.id,"mercy_crown_defended","mercy_crown",String(current.id),JSON.stringify({match_id:matchId,champion_team_id:winner})).run();
      return json({data:{status:"defended",team_id:winner}});
    }
    if(current){
      const challenge=await env.DB.prepare("SELECT id FROM mercy_crown_challenges WHERE challenger_team_id=? AND status IN ('pending','accepted','scheduled') LIMIT 1").bind(winner).first();
      if(!challenge)return json({error:{code:"NO_TITLE_CHALLENGE",message:"Победитель должен быть зарегистрированным претендентом."}},409);
      await env.DB.prepare("UPDATE mercy_crown_reigns SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='title_lost' WHERE id=?").bind(current.id).run();
    }else{
      const final=await env.DB.prepare("SELECT m.id FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=? AND m.bracket='final' LIMIT 1").bind(matchId).first();
      if(!final)return json({error:{code:"NOT_FINAL",message:"Первую корону можно вручить только по подтверждённому финалу."}},409);
    }
    const inserted=await env.DB.prepare("INSERT INTO mercy_crown_reigns (team_id,source_match_id,awarded_by) VALUES (?,?,?)").bind(winner,matchId,session.user.id).run();
    await env.DB.prepare("UPDATE mercy_crown_challenges SET status='completed',result_match_id=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),decided_by=? WHERE challenger_team_id IN (?,?) AND status IN ('pending','accepted','scheduled')").bind(matchId,session.user.id,match.team_a_id,match.team_b_id).run();
    await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?,?)").bind(await createAuditEventId(env.DB),session.user.id,"mercy_crown_transferred","mercy_crown",String(inserted.meta?.last_row_id),JSON.stringify({match_id:matchId,champion_team_id:winner,previous_team_id:current?.team_id||null})).run();
    return json({data:{status:"transferred",team_id:winner}});
  }
  return json({error:{code:"INVALID_ACTION",message:"Неизвестное действие."}},400);
}
