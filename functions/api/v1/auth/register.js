import { json, methodNotAllowed } from "../_lib/http.js";
import { normalizedEmail, validEmail, sha256, sessionCookie, SESSION_TTL, sameOrigin } from "../_lib/session-auth.js";

const ITERATIONS = 100000;
async function passwordHash(password, saltBytes) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: ITERATIONS }, material, 256);
  return "pbkdf2-sha256$" + ITERATIONS + "$" + btoa(String.fromCharCode(...saltBytes)) + "$" + btoa(String.fromCharCode(...new Uint8Array(bits)));
}
function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({error:{code:"DATABASE_NOT_CONFIGURED",message:"База данных не подключена."}},503);
  if (!request.headers.get("origin") || !sameOrigin(request,env)) return json({error:{code:"ORIGIN_REJECTED",message:"Запрос отклонён."}},403);

  let emailHash = "", ipHash = "";
  try {
    let body;
    try { body=await request.json(); } catch { return json({error:{code:"INVALID_JSON",message:"Проверьте данные формы."}},400); }
    const email=normalizedEmail(body.email), password=String(body.password||"");
    const nickname=String(body.nickname||"").trim().slice(0,32), gameId=String(body.game_id||"").trim().slice(0,40);
    const role=String(body.role||""), region=String(body.region||"").trim().slice(0,80);
    const displayName=String(body.display_name||nickname).trim().slice(0,80);
    if(!validEmail(email)) return json({error:{code:"INVALID_EMAIL",message:"Укажи корректный email."}},400);
    if(password.length<12||password.length>128) return json({error:{code:"WEAK_PASSWORD",message:"Пароль должен содержать от 12 до 128 символов."}},400);
    if(nickname.length<2||!/^[\p{L}\p{N}_ .-]+$/u.test(nickname)) return json({error:{code:"INVALID_NICKNAME",message:"Ник должен содержать от 2 до 32 допустимых символов."}},400);
    if(!gameId||!/^[0-9-]{5,40}$/.test(gameId)) return json({error:{code:"INVALID_GAME_ID",message:"Укажи корректный игровой ID MLBB."}},400);
    if(!["EXP","JUNGLE","MID","GOLD","ROAM","FLEX"].includes(role)) return json({error:{code:"INVALID_ROLE",message:"Выбери игровую роль."}},400);

    // Verify every table touched by registration before writing anything.
    const requiredTables = ["users","players","user_roles","audit_events","auth_sessions","auth_login_attempts"];
    const tableChecks = await Promise.all(requiredTables.map(name =>
      env.DB.prepare("PRAGMA table_info("+name+")").all()
    ));
    const columns = Object.fromEntries(requiredTables.map((name,i) => [name,new Set((tableChecks[i].results||[]).map(col=>col.name))]));
    const requiredColumns = {
      users:["id","email","display_name","password_hash"],
      players:["id","user_id","game_id","nickname","role","region","profile_status"],
      user_roles:["user_id","role"],
      audit_events:["id","actor_id","action","entity_type","entity_id","after_json"],
      auth_sessions:["id","user_id","token_hash","expires_at"],
      auth_login_attempts:["id","email_hash","ip_hash","attempted_at"]
    };
    const missing=[];
    for(const [table,names] of Object.entries(requiredColumns)) for(const name of names) if(!columns[table].has(name)) missing.push(table+"."+name);
    if(missing.length) {
      console.error("Registration schema is incomplete:",missing.join(", "));
      return json({error:{code:"REGISTRATION_MIGRATION_REQUIRED",message:"База данных не обновлена (отсутствуют: "+missing.join(", ")+"). Проверь миграции MERCY ARENA."}},503);
    }

    emailHash=await sha256(email);
    const ip=request.headers.get("CF-Connecting-IP")||"unknown";
    ipHash=await sha256(ip+String(env.AUTH_RATE_LIMIT_SALT||env.APP_BASE_URL||"mercy-arena"));
    const now=Math.floor(Date.now()/1000);
    await env.DB.prepare("DELETE FROM auth_login_attempts WHERE attempted_at<=?").bind(now-3600).run();
    const attempts=await env.DB.prepare("SELECT COUNT(*) AS total FROM auth_login_attempts WHERE (email_hash=? OR ip_hash=?) AND attempted_at>?").bind(emailHash,ipHash,now-3600).first();
    if((attempts?.total||0)>=20) return json({error:{code:"REGISTER_RATE_LIMITED",message:"Слишком много попыток регистрации. Подожди немного и попробуй снова."}},429);

    const existing=await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if(existing) return json({error:{code:"EMAIL_EXISTS",message:"Аккаунт с таким email уже существует. Войди в него."}},409);

    const salt=crypto.getRandomValues(new Uint8Array(16));
    const storedHash=await passwordHash(password,salt);
    const userId=crypto.randomUUID(), playerId=crypto.randomUUID();
    const token=b64url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash=await sha256(token);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO auth_login_attempts (id,email_hash,ip_hash,attempted_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),emailHash,ipHash,now),
      env.DB.prepare("INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,?,?)").bind(userId,email,displayName||nickname,storedHash),
      env.DB.prepare("INSERT INTO user_roles (user_id,role) VALUES (?,'player')").bind(userId),
      env.DB.prepare("INSERT INTO players (id,user_id,game_id,nickname,role,region,profile_status) VALUES (?,?,?,?,?,?, 'pending')").bind(playerId,userId,gameId,nickname,role,region||null),
      env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (? ,?,'player_profile_submitted','player',?,?)").bind(crypto.randomUUID(),userId,playerId,JSON.stringify({nickname,role,region,profile_status:"pending"})),
      env.DB.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),userId,tokenHash,now+SESSION_TTL)
    ]);
    await env.DB.prepare("DELETE FROM auth_login_attempts WHERE email_hash=? OR ip_hash=?").bind(emailHash,ipHash).run();
    return json({authenticated:true,account:{id:userId,email,name:displayName||nickname},profile:{id:playerId,status:"pending",nickname}},201,{"set-cookie":sessionCookie(token)});
  } catch(error) {
    console.error("Player registration request failed:",error);
    if(emailHash||ipHash) await env.DB.prepare("DELETE FROM auth_login_attempts WHERE email_hash=? OR ip_hash=?").bind(emailHash||"__none__",ipHash||"__none__").run().catch(()=>{});
    const detail=String(error?.message||"");
    if(/UNIQUE constraint failed/i.test(detail)) return json({error:{code:"REGISTRATION_CONFLICT",message:"Этот email или игровой профиль уже зарегистрирован."}},409);
    if(/FOREIGN KEY constraint failed/i.test(detail)) return json({error:{code:"REGISTRATION_RELATION_ERROR",message:"Не удалось связать аккаунт с игровым профилем. Проверь структуру базы данных."}},409);
    const safeDetail=detail.replace(/[\r\n\t]+/g," ").slice(0,180);
    return json({error:{code:"REGISTRATION_FAILED",message:"Регистрация не завершена: "+(safeDetail||"ошибка базы данных или конфигурации")}},500);
  }
}

export function onRequestGet(){return methodNotAllowed("POST");}
