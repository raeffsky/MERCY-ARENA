import { json, methodNotAllowed } from "../_lib/http.js";
import { normalizedEmail, validEmail, sha256, sessionCookie, SESSION_TTL, sameOrigin } from "../_lib/session-auth.js";

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных не подключена." } }, 503);
  const origin = request.headers.get("origin");
  if (!origin || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);

  const adminEmail = normalizedEmail(env.BOOTSTRAP_ADMIN_EMAIL);
  const configuredPassword = String(env.ADMIN_LOGIN_PASSWORD || "");
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Проверьте формат запроса." } }, 400); }
  const email = normalizedEmail(body.email);
  const password = String(body.password || "");
  if (!validEmail(email) || password.length > 256) {
    return json({ error: { code: "INVALID_CREDENTIALS", message: "Неверный email или пароль." } }, 401);
  }

  const emailHash = await sha256(email);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(ip + String(env.AUTH_RATE_LIMIT_SALT || env.APP_BASE_URL || "mercy-arena"));
  const now = Math.floor(Date.now() / 1000);
  const attempts = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM auth_login_attempts WHERE (email_hash=? OR ip_hash=?) AND attempted_at>?"
  ).bind(emailHash, ipHash, now - 900).first();
  if ((attempts?.total || 0) >= 10) {
    return json({ error: { code: "LOGIN_RATE_LIMITED", message: "Слишком много попыток. Подожди 15 минут." } }, 429);
  }
  await env.DB.prepare(
    "INSERT INTO auth_login_attempts (id,email_hash,ip_hash,attempted_at) VALUES (?,?,?,?)"
  ).bind(crypto.randomUUID(), emailHash, ipHash, now).run();

  let user = await env.DB.prepare("SELECT id,email,display_name,password_hash FROM users WHERE email=?").bind(email).first();
  let roles = [];
  let passwordMatches = false;
  if (user && user.password_hash && user.password_hash.startsWith("pbkdf2-sha256$")) {
    try {
      const parts = user.password_hash.split("$");
      const iterations = Number(parts[1]);
      const salt = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
      const expected = Uint8Array.from(atob(parts[3]), c => c.charCodeAt(0));
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
      const actual = new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations},material,256));
      passwordMatches = equalBytes(actual,expected);
    } catch { passwordMatches = false; }
  }
  if (!passwordMatches && validEmail(adminEmail) && configuredPassword.length >= 12 && email === adminEmail) {
    const suppliedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
    const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(configuredPassword)));
    passwordMatches = equalBytes(suppliedHash, expectedHash);
    if (passwordMatches) {
      if (!user) {
        await env.DB.prepare("INSERT OR IGNORE INTO users (email,display_name) VALUES (?,?)").bind(adminEmail, adminEmail).run();
        user = await env.DB.prepare("SELECT id,email,display_name,password_hash FROM users WHERE email=?").bind(adminEmail).first();
      }
      if (user) {
        const granted = await env.DB.prepare("INSERT OR IGNORE INTO user_roles (user_id,role) VALUES (?,'administrator')").bind(user.id).run();
        if (granted.meta && granted.meta.changes === 1) {
          await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'bootstrap_admin_created','user',?,?)")
            .bind(user.id, user.id, JSON.stringify({ email: adminEmail, role: "administrator", method: "password" })).run();
        }
      }
    }
  }
  if (!user || !passwordMatches) return json({ error: { code: "INVALID_CREDENTIALS", message: "Неверный email или пароль." } }, 401);
  const roleRows = await env.DB.prepare("SELECT role FROM user_roles WHERE user_id=?").bind(user.id).all();
  roles = (roleRows.results || []).map(row => row.role);

  await env.DB.prepare("DELETE FROM auth_login_attempts WHERE email_hash=? OR ip_hash=?").bind(emailHash, ipHash).run();
  const sessionToken = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...sessionToken)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const tokenHash = await sha256(token);
  await env.DB.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), user.id, tokenHash, now + SESSION_TTL).run();
  await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'login','user',?,?)")
    .bind(user.id, user.id, JSON.stringify({ method: "password" })).run();

  return json({ authenticated: true, account: { email: user.email, name: user.display_name }, roles }, 200, { "set-cookie": sessionCookie(token) });
}

export function onRequestGet() { return methodNotAllowed("POST"); }
