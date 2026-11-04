import { randomToken, sha256, sessionCookie, SESSION_TTL } from "../_lib/session-auth.js";

function redirect(path, cookie) {
  const headers = { Location: path, "Cache-Control": "no-store" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return new Response("Database unavailable", { status: 503 });
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return redirect("/#/organizer?auth=invalid");
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const consumed = await env.DB.prepare("UPDATE auth_magic_links SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?").bind(now, tokenHash, now).run();
  if (!consumed.meta || consumed.meta.changes !== 1) return redirect("/#/organizer?auth=expired");

  const link = await env.DB.prepare("SELECT email FROM auth_magic_links WHERE token_hash=?").bind(tokenHash).first();
  if (!link?.email) return redirect("/#/organizer?auth=invalid");
  const email = String(link.email).trim().toLowerCase();
  const bootstrapEmail = String(env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  let user = await env.DB.prepare("SELECT id,email,display_name FROM users WHERE email=?").bind(email).first();

  if (!user && bootstrapEmail && email === bootstrapEmail) {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT OR IGNORE INTO users (id,email,display_name) VALUES (?,?,?)").bind(id, email, email).run();
    user = await env.DB.prepare("SELECT id,email,display_name FROM users WHERE email=?").bind(email).first();
    if (user) {
      await env.DB.prepare("INSERT OR IGNORE INTO user_roles (user_id,role) VALUES (?,'administrator')").bind(user.id).run();
      await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'bootstrap_admin_created','user',?,?)")
        .bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ email, role: "administrator", method: "email_magic_link" })).run();
    }
  }
  if (!user) return redirect("/#/organizer?auth=not_allowed");

  const tokenValue = randomToken(32);
  const tokenDigest = await sha256(tokenValue);
  await env.DB.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), user.id, tokenDigest, now + SESSION_TTL).run();
  await env.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'login','user',?,?)")
    .bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ method: "email_magic_link" })).run();
  return redirect("/#/organizer?auth=success", sessionCookie(tokenValue));
}
