import { createAuditEventId } from "./_lib/audit.js";
import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";
import { advanceWinner } from "./_lib/match-progression.js";

const FORMATS = new Set(["single_elimination","double_elimination","round_robin"]);
const now = () => new Date().toISOString();
const fail = (code, message, status=400) => json({error:{code,message}},status);
const isHttpsUrl = (value) => {
  if (value == null || value === "") return true;
  try { return new URL(String(value)).protocol === "https:"; } catch { return false; }
};
function dateValue(value,label) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error("Некорректная дата: "+label+".");
  return new Date(parsed).toISOString();
}
function validateDates(data) {
  const opens=dateValue(data.registration_open_at,"открытие регистрации");
  const closes=dateValue(data.registration_close_at,"закрытие регистрации");
  const starts=dateValue(data.starts_at,"начало турнира");
  const ends=dateValue(data.ends_at,"окончание турнира");
  if(opens&&closes&&Date.parse(opens)>Date.parse(closes))throw new Error("Регистрация не может закрываться раньше открытия.");
  if(starts&&ends&&Date.parse(starts)>Date.parse(ends))throw new Error("Турнир не может завершаться раньше начала.");
  return {registration_open_at:opens,registration_close_at:closes,starts_at:starts,ends_at:ends};
}
async function audit(db,actor,action,entity,id,before,after) {
  await db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?,?)")
    .bind(await createAuditEventId(db),actor,action,entity,String(id),before?JSON.stringify(before):null,after?JSON.stringify(after):null).run();
}
async function authorize(request,env) {
  if(!env.DB)return {response:databaseUnavailable()};
  const session=await getSessionUser(request,env);
  if(session.error)return {response:session.error};
  if(!session.user)return {response:fail("UNAUTHORIZED","Войди в аккаунт организатора.",401)};
  const owner=session.user.roles.includes("administrator")&&isOwnerAccount(session.user,env);
  if(!owner&&!session.user.roles.includes("organizer"))return {response:fail("FORBIDDEN","Кабинет доступен только назначенным организаторам.",403)};
  return {user:session.user,owner};
}
async function ownedTournament(db,id,user,owner) {
  return db.prepare("SELECT * FROM tournaments WHERE id=? AND (?=1 OR organizer_id=?) LIMIT 1")
    .bind(String(id),owner?1:0,user.id).first();
}
export async function onRequestGet({request,env}) {
  const auth=await authorize(request,env);
  if(auth.response)return auth.response;
  try {
    const scope=auth.owner?"1=1":"t.organizer_id=?";
    const bind=auth.owner?[]:[auth.user.id];
    const {results:tournaments}=await env.DB.prepare(
      "SELECT t.*,(SELECT COUNT(*) FROM tournament_registrations r WHERE r.tournament_id=t.id) AS applications_count,"+
      "(SELECT COUNT(*) FROM tournament_registrations r JOIN teams tm ON tm.id=r.team_id AND tm.status='active' AND tm.archived_at IS NULL WHERE r.tournament_id=t.id AND r.status='approved') AS approved_teams,"+
      "(SELECT COUNT(*) FROM matches m WHERE m.tournament_id=t.id) AS matches_count FROM tournaments t WHERE "+scope+
      " ORDER BY t.created_at DESC,t.id DESC LIMIT 100"
    ).bind(...bind).all();
    const {results:applications}=await env.DB.prepare(
      "SELECT r.id,r.tournament_id,r.team_id,r.status,r.submitted_at,r.selected_slot,r.captain_note,t.title AS tournament_title,"+
      "tm.name AS team_name,tm.tag AS team_tag,tm.status AS team_status,tm.archived_at AS team_archived_at,tm.captain_id,"+
      "(SELECT COUNT(*) FROM tournament_registration_roster rr WHERE rr.registration_id=r.id AND rr.roster_role='starter') AS starters,"+
      "(SELECT COUNT(*) FROM tournament_registration_roster rr WHERE rr.registration_id=r.id AND rr.roster_role='substitute') AS substitutes,"+
      "(SELECT GROUP_CONCAT(p.nickname, ', ') FROM tournament_registration_roster rr JOIN players p ON p.id=rr.player_id WHERE rr.registration_id=r.id AND rr.roster_role='starter') AS starter_names,"+
      "(SELECT GROUP_CONCAT(p.nickname, ', ') FROM tournament_registration_roster rr JOIN players p ON p.id=rr.player_id WHERE rr.registration_id=r.id AND rr.roster_role='substitute') AS substitute_names "+
      "FROM tournament_registrations r JOIN tournaments t ON t.id=r.tournament_id JOIN teams tm ON tm.id=r.team_id WHERE "+scope+
      " ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.submitted_at DESC LIMIT 200"
    ).bind(...bind).all();
    const {results:matches}=await env.DB.prepare(
      "SELECT m.id,m.tournament_id,m.round_number,m.bracket,m.match_number,m.scheduled_at,m.status,m.team_a_id,m.team_b_id,m.score_a,m.score_b,m.winner_team_id,"+
      "m.result_source,m.result_verified_at,t.title AS tournament_title,ta.name AS team_a_name,tb.name AS team_b_name "+
      "FROM matches m JOIN tournaments t ON t.id=m.tournament_id LEFT JOIN teams ta ON ta.id=m.team_a_id LEFT JOIN teams tb ON tb.id=m.team_b_id WHERE "+scope+
      " ORDER BY m.scheduled_at IS NULL,m.scheduled_at,m.tournament_id,m.round_number,m.match_number LIMIT 300"
    ).bind(...bind).all();
    const {results:seasons}=await env.DB.prepare("SELECT id,title,season_number,status FROM seasons WHERE status IN ('planning','active') ORDER BY season_number DESC,id DESC LIMIT 100").all();
    return json({data:{tournaments:tournaments||[],applications:applications||[],matches:matches||[],seasons:seasons||[]},meta:{owner:auth.owner}});
  } catch(error) {
    console.error("MERCY ORGANIZER read failed:",error);
    return fail("ORGANIZER_READ_FAILED","Не удалось загрузить кабинет организатора. Проверь миграции и журнал Functions.",500);
  }
}
export async function onRequestPost({request,env}) {
  if(!request.headers.get("origin")||!sameOrigin(request,env))return fail("ORIGIN_REJECTED","Запрос отклонён.",403);
  const auth=await authorize(request,env);
  if(auth.response)return auth.response;
  let body;
  try{body=await request.json()}catch{return fail("INVALID_JSON","Некорректный JSON.")};
  const action=String(body?.action||"");
  const data=body?.data&&typeof body.data==="object"?body.data:{};
  try {
    if(action==="create_tournament"){
      const title=String(data.title||"").trim().slice(0,120);
      const format=String(data.format||"");
      if(title.length<3)return fail("INVALID_TITLE","Название турнира должно содержать минимум 3 символа.");
      if(!FORMATS.has(format))return fail("INVALID_FORMAT","Выбери поддерживаемый формат сетки.");
      const maxTeams=data.max_teams==null||data.max_teams===""?null:Number(data.max_teams);
      if(maxTeams!==null&&(!Number.isSafeInteger(maxTeams)||maxTeams<2||maxTeams>32))return fail("INVALID_TEAM_LIMIT","Лимит турнира должен быть от 2 до 32 команд.");
      if(!isHttpsUrl(data.poster_url)||!isHttpsUrl(data.rules_url))return fail("INVALID_URL","Постер и правила должны использовать HTTPS.");
      if(data.stream_url&&!/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(String(data.stream_url).trim()))return fail("INVALID_STREAM_URL","Для трансляции укажи HTTPS-ссылку YouTube.");
      const dates=validateDates(data);
      let seasonId=data.season_id==null||data.season_id===""?null:Number(data.season_id);
      if(seasonId!==null){
        if(!Number.isSafeInteger(seasonId)||seasonId<1)return fail("INVALID_SEASON","Некорректный сезон.");
        const season=await env.DB.prepare("SELECT id FROM seasons WHERE id=? AND status IN ('planning','active')").bind(seasonId).first();
        if(!season)return fail("SEASON_NOT_FOUND","Выбранный сезон не найден или уже закрыт.",409);
      }
      const createdAt=now();
      const result=await env.DB.prepare(
        "INSERT INTO tournaments (title,description,game,region,format,status,max_teams,registration_open_at,registration_close_at,starts_at,ends_at,rules_url,season_id,organizer_id,published_at,poster_url,stream_url,prize_pool,created_at,updated_at) "+
        "VALUES (?,?, 'Mobile Legends: Bang Bang', ?,?,'draft',?,?,?,?,?,?,?,?,NULL,?,?,?, ?,?)"
      ).bind(title,String(data.description||"").trim().slice(0,2000)||null,String(data.region||"").trim().slice(0,80)||null,format,maxTeams,
        dates.registration_open_at,dates.registration_close_at,dates.starts_at,dates.ends_at,
        data.rules_url?String(data.rules_url).trim():null,seasonId,auth.user.id,
        data.poster_url?String(data.poster_url).trim():null,data.stream_url?String(data.stream_url).trim():null,
        String(data.prize_pool||"").trim().slice(0,120)||null,createdAt,createdAt
      ).run();
      const id=result.meta?.last_row_id;
      if(!id)return fail("TOURNAMENT_CREATE_FAILED","Не удалось получить ID турнира после сохранения.",500);
      const after=await env.DB.prepare("SELECT * FROM tournaments WHERE id=?").bind(id).first();
      await audit(env.DB,auth.user.id,"organizer_tournament_created","tournament",id,null,after);
      return json({data:after},201);
    }
    if(action==="update_tournament"){
      const id=String(body.id||"").trim();
      if(!id)return fail("INVALID_TOURNAMENT","Укажи ID турнира.");
      const before=await ownedTournament(env.DB,id,auth.user,auth.owner);
      if(!before)return fail("TOURNAMENT_NOT_FOUND","Турнир не найден или недоступен.",404);
      if(["completed","cancelled"].includes(before.status))return fail("TOURNAMENT_LOCKED","Завершённый или отменённый турнир нельзя редактировать.",409);
      const title=String(data.title??before.title).trim().slice(0,120);
      const format=String(data.format??before.format);
      if(title.length<3)return fail("INVALID_TITLE","Название турнира должно содержать минимум 3 символа.");
      if(!FORMATS.has(format))return fail("INVALID_FORMAT","Недопустимый формат сетки.");
      const maxValue=Object.prototype.hasOwnProperty.call(data,"max_teams")?data.max_teams:before.max_teams;
      const maxTeams=maxValue==null||maxValue===""?null:Number(maxValue);
      if(maxTeams!==null&&(!Number.isSafeInteger(maxTeams)||maxTeams<2||maxTeams>32))return fail("INVALID_TEAM_LIMIT","Лимит турнира должен быть от 2 до 32 команд.");
      if(String(data.format??before.format)!==String(before.format)){
        const existingMatches=await env.DB.prepare("SELECT COUNT(*) AS total FROM matches WHERE tournament_id=?").bind(id).first();
        if(Number(existingMatches?.total||0)>0)return fail("BRACKET_FORMAT_LOCKED","Формат нельзя менять после создания матчей. Сначала обратись к владельцу платформы.",409);
      }
      if(maxTeams!==null){
        const occupied=await env.DB.prepare("SELECT COUNT(*) AS total FROM tournament_registrations r JOIN teams tm ON tm.id=r.team_id AND tm.status='active' AND tm.archived_at IS NULL WHERE r.tournament_id=? AND r.status IN ('pending','approved')").bind(id).first();
        if(Number(occupied?.total||0)>maxTeams)return fail("TEAM_LIMIT_BELOW_OCCUPIED","Новый лимит меньше количества уже поданных и одобренных заявок.",409);
      }
      const fieldValue=function(key){return Object.prototype.hasOwnProperty.call(data,key)?data[key]:before[key]};
      const merged={registration_open_at:fieldValue("registration_open_at"),registration_close_at:fieldValue("registration_close_at"),starts_at:fieldValue("starts_at"),ends_at:fieldValue("ends_at")};
      const dates=validateDates(merged);
      if(!isHttpsUrl(data.poster_url??before.poster_url)||!isHttpsUrl(data.rules_url??before.rules_url))return fail("INVALID_URL","Постер и правила должны использовать HTTPS.");
      const stream=data.stream_url??before.stream_url;
      if(stream&&!/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(String(stream).trim()))return fail("INVALID_STREAM_URL","Для трансляции укажи HTTPS-ссылку YouTube.");
      const next={
        title,description:String(data.description??before.description??"").trim().slice(0,2000)||null,
        region:String(data.region??before.region??"").trim().slice(0,80)||null,format,max_teams:maxTeams,
        registration_open_at:dates.registration_open_at,registration_close_at:dates.registration_close_at,
        starts_at:dates.starts_at,ends_at:dates.ends_at,
        rules_url:(data.rules_url??before.rules_url)||null,poster_url:(data.poster_url??before.poster_url)||null,
        stream_url:stream||null,prize_pool:String(data.prize_pool??before.prize_pool??"").trim().slice(0,120)||null,
        season_id:data.season_id==null?before.season_id:(data.season_id===""?null:Number(data.season_id)),updated_at:now()
      };
      if(next.season_id!=null){
        const season=await env.DB.prepare("SELECT id FROM seasons WHERE id=? AND status IN ('planning','active')").bind(next.season_id).first();
        if(!season)return fail("SEASON_NOT_FOUND","Выбранный сезон не найден или уже закрыт.",409);
      }
      const writes=await env.DB.prepare(
        "UPDATE tournaments SET title=?,description=?,region=?,format=?,max_teams=?,registration_open_at=?,registration_close_at=?,starts_at=?,ends_at=?,rules_url=?,poster_url=?,stream_url=?,prize_pool=?,season_id=?,updated_at=? WHERE id=? AND (?=1 OR organizer_id=?) AND status NOT IN ('completed','cancelled')"
      ).bind(next.title,next.description,next.region,next.format,next.max_teams,next.registration_open_at,next.registration_close_at,next.starts_at,next.ends_at,
        next.rules_url,next.poster_url,next.stream_url,next.prize_pool,next.season_id,next.updated_at,id,auth.owner?1:0,auth.user.id).run();
      if(!writes.meta?.changes)return fail("TOURNAMENT_UPDATE_CONFLICT","Турнир изменился или больше недоступен.",409);
      const after=await env.DB.prepare("SELECT * FROM tournaments WHERE id=?").bind(id).first();
      await audit(env.DB,auth.user.id,"organizer_tournament_updated","tournament",id,before,after);
      return json({data:after});
    }
    if(action==="publish_tournament"){
      const id=String(body.id||"").trim();
      const before=await ownedTournament(env.DB,id,auth.user,auth.owner);
      if(!before)return fail("TOURNAMENT_NOT_FOUND","Турнир не найден или недоступен.",404);
      if(before.status==="published")return json({data:before,already_published:true});
      if(before.status!=="draft")return fail("TOURNAMENT_STATUS_INVALID","Опубликовать можно только черновик.",409);
      if(!before.title||!FORMATS.has(before.format))return fail("TOURNAMENT_INCOMPLETE","Заполни название и формат турнира.");
      const dates=validateDates(before);
      const publishedAt=now();
      const write=await env.DB.prepare("UPDATE tournaments SET status='published',published_at=?,updated_at=? WHERE id=? AND status='draft' AND (?=1 OR organizer_id=?)")
        .bind(publishedAt,publishedAt,id,auth.owner?1:0,auth.user.id).run();
      if(!write.meta?.changes)return fail("TOURNAMENT_PUBLISH_CONFLICT","Турнир уже изменился.",409);
      const after=await env.DB.prepare("SELECT * FROM tournaments WHERE id=?").bind(id).first();
      await audit(env.DB,auth.user.id,"organizer_tournament_published","tournament",id,before,after);
      return json({data:after});
    }
    if(action==="review_application"){
      const id=String(body.id||"").trim(),status=data.status;
      if(!id||!["approved","rejected"].includes(status))return fail("INVALID_APPLICATION","Укажи заявку и решение.");
      const before=await env.DB.prepare(
        "SELECT r.*,t.status AS tournament_status,t.max_teams,t.organizer_id,tm.status AS team_status,tm.archived_at AS team_archived_at "+
        "FROM tournament_registrations r JOIN tournaments t ON t.id=r.tournament_id JOIN teams tm ON tm.id=r.team_id WHERE r.id=?"
      ).bind(id).first();
      if(!before||(!auth.owner&&String(before.organizer_id)!==String(auth.user.id)))return fail("APPLICATION_NOT_FOUND","Заявка не найдена или недоступна.",404);
      if(before.status!=="pending")return fail("APPLICATION_REVIEWED","Заявка уже рассмотрена.",409);
      if(status==="approved"&&(!["published","active"].includes(before.tournament_status)||before.team_status!=="active"||before.team_archived_at!=null))
        return fail("APPLICATION_NOT_ELIGIBLE","Нельзя одобрить заявку: турнир или команда закрыты.",409);
      const reviewedAt=now();
      const write=await env.DB.prepare(
        "UPDATE tournament_registrations SET status=?,reviewed_at=?,reviewer_id=?,updated_at=? WHERE id=? AND status='pending' "+
        "AND (?!='approved' OR EXISTS (SELECT 1 FROM teams tm WHERE tm.id=tournament_registrations.team_id AND tm.status='active' AND tm.archived_at IS NULL)) "+
        "AND (?!='approved' OR EXISTS (SELECT 1 FROM tournaments t WHERE t.id=tournament_registrations.tournament_id AND t.status IN ('published','active') AND (t.max_teams IS NULL OR "+
        "(SELECT COUNT(*) FROM tournament_registrations approved JOIN teams cap ON cap.id=approved.team_id AND cap.status='active' AND cap.archived_at IS NULL WHERE approved.tournament_id=t.id AND approved.status='approved')<t.max_teams)))"
      ).bind(status,reviewedAt,auth.user.id,reviewedAt,id,status,status).run();
      if(!write.meta?.changes)return fail("APPLICATION_REVIEW_CONFLICT","Заявка уже обработана, команда закрыта или лимит заполнен.",409);
      const after=await env.DB.prepare("SELECT * FROM tournament_registrations WHERE id=?").bind(id).first();
      const captain=await env.DB.prepare("SELECT captain_id,name FROM teams WHERE id=?").bind(before.team_id).first();
      const tournament=await env.DB.prepare("SELECT title FROM tournaments WHERE id=?").bind(before.tournament_id).first();
      const statements=[
        env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,'tournament_registration',?,?)")
          .bind(await createAuditEventId(env.DB),auth.user.id,"registration_"+status,id,JSON.stringify({status,tournament_id:before.tournament_id,team_id:before.team_id})),
      ];
      if(captain?.captain_id)statements.push(env.DB.prepare("INSERT INTO notifications (user_id,type,title,message,link,entity_type,entity_id) VALUES (?,?,?,?,?,'tournament_registration',?)")
        .bind(captain.captain_id,"application_"+status,status==="approved"?"Заявка одобрена":"Заявка отклонена",
          "Заявка команды "+captain.name+" на турнир «"+(tournament?.title||"") +"» "+(status==="approved"?"одобрена.":"отклонена."),
          "#/tournament/"+before.tournament_id,id));
      await env.DB.batch(statements);
      return json({data:after});
    }
    if(action==="update_match"){
      const id=String(body.id||"").trim();
      const match=await env.DB.prepare(
        "SELECT m.*,t.organizer_id,t.status AS tournament_status FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=?"
      ).bind(id).first();
      if(!match||(!auth.owner&&String(match.organizer_id)!==String(auth.user.id)))return fail("MATCH_NOT_FOUND","Матч не найден или недоступен.",404);
      if(match.status==="completed")return fail("MATCH_COMPLETED","Завершённый матч нельзя изменить. Для исправления результата обратись к владельцу платформы.",409);
      if(!["published","active"].includes(match.tournament_status))return fail("TOURNAMENT_NOT_ACTIVE","Управлять матчами можно только в опубликованном или активном турнире.",409);
      const status=String(data.status||match.status);
      if(!["scheduled","in_progress","cancelled","postponed"].includes(status))return fail("INVALID_MATCH_STATUS","Недопустимый статус матча.");
      if(status==="in_progress"&&(match.team_a_id==null||match.team_b_id==null))return fail("MATCH_TEAMS_REQUIRED","Нельзя начать матч без двух назначенных команд.");
      const scheduledAt=data.scheduled_at==null||data.scheduled_at===""?null:dateValue(data.scheduled_at,"дата матча");
      const write=await env.DB.prepare("UPDATE matches SET status=?,scheduled_at=?,updated_at=? WHERE id=? AND status!='completed'")
        .bind(status,scheduledAt,now(),id).run();
      if(!write.meta?.changes)return fail("MATCH_UPDATE_CONFLICT","Матч уже изменён или завершён.",409);
      const after=await env.DB.prepare("SELECT * FROM matches WHERE id=?").bind(id).first();
      await audit(env.DB,auth.user.id,"organizer_match_updated","match",id,match,after);
      return json({data:after});
    }
    if(action==="submit_result"){
      const id=String(body.id||"").trim(),scoreA=Number(data.score_a),scoreB=Number(data.score_b);
      if(!id||!Number.isSafeInteger(scoreA)||!Number.isSafeInteger(scoreB)||scoreA<0||scoreB<0||scoreA===scoreB)
        return fail("INVALID_RESULT","Укажи два разных целых счёта от нуля.");
      const match=await env.DB.prepare(
        "SELECT m.*,t.organizer_id,t.title AS tournament_title,t.status AS tournament_status FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=?"
      ).bind(id).first();
      if(!match||(!auth.owner&&String(match.organizer_id)!==String(auth.user.id)))return fail("MATCH_NOT_FOUND","Матч не найден или недоступен.",404);
      if(!["published","active"].includes(match.tournament_status))return fail("TOURNAMENT_NOT_ACTIVE","Результат можно внести только в опубликованном или активном турнире.",409);
      if(!["scheduled","in_progress"].includes(match.status)||match.team_a_id==null||match.team_b_id==null)
        return fail("MATCH_NOT_PLAYABLE","Матч не готов к внесению результата.",409);
      const winner=scoreA>scoreB?match.team_a_id:match.team_b_id,verifiedAt=now();
      const write=await env.DB.prepare(
        "UPDATE matches SET status='completed',score_a=?,score_b=?,winner_team_id=?,result_source='organizer_manual',result_verified_at=?,updated_at=? WHERE id=? AND status IN ('scheduled','in_progress')"
      ).bind(scoreA,scoreB,winner,verifiedAt,verifiedAt,id).run();
      if(!write.meta?.changes)return fail("RESULT_ALREADY_SAVED","Результат уже сохранён другим запросом.",409);
      const after=await env.DB.prepare("SELECT * FROM matches WHERE id=?").bind(id).first();
      await audit(env.DB,auth.user.id,"organizer_match_result_submitted","match",id,match,after);
      try{
        const progression=await advanceWinner(env.DB,id,winner);
        return json({data:after,progression});
      }catch(error){
        console.error("Organizer match progression failed:",error);
        return json({error:{code:"RESULT_SAVED_PROGRESSION_PENDING",message:"Результат сохранён, но продвижение победителя не завершилось. Владелец платформы увидит ошибку в журнале."},data:after,result_saved:true},503);
      }
    }
    return fail("UNKNOWN_ACTION","Неизвестное действие.");
  }catch(error){
    console.error("MERCY ORGANIZER write failed:",error);
    return fail("ORGANIZER_WRITE_FAILED","Не удалось сохранить изменение. Проверь данные и повтори попытку.",500);
  }
}
export function onRequestPut(){return methodNotAllowed("GET, POST");}
export function onRequestDelete(){return methodNotAllowed("GET, POST");}
