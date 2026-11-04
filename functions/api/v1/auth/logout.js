import { json, methodNotAllowed } from "../_lib/http.js";
import { cookieValue, sha256, clearSessionCookie, sameOrigin } from "../_lib/session-auth.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных не подключена." } }, 503);
  if (!sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const token = cookieValue(request, "mercy_session");
  if (token) await env.DB.prepare("UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").bind(Math.floor(Date.now() / 1000), await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}
export function onRequestGet() { return methodNotAllowed("POST"); }
