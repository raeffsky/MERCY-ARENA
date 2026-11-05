import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

async function auth(request, env) {
  if (!env.DB) return { response: databaseUnavailable() };
  const session = await getSessionUser(request, env);
  if (session.error) return { response: session.error };
  if (!session.user) return { response: json({ error: { code: "AUTH_REQUIRED", message: "Войди в аккаунт." } }, 401) };
  return { user: session.user };
}

export async function onRequestGet({ request, env }) {
  const session = await auth(request, env);
  if (session.response) return session.response;
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const { results } = await env.DB.prepare("SELECT id,type,title,message,link,entity_type,entity_id,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?").bind(session.user.id, limit).all();
  const unread = await env.DB.prepare("SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND read_at IS NULL").bind(session.user.id).first();
  return json({ data: results || [], meta: { unread: unread?.total || 0, limit } });
}

export async function onRequestPut({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const session = await auth(request, env);
  if (session.response) return session.response;
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Некорректные данные." } }, 400); }
  const now = new Date().toISOString();
  if (body.action === "read_all") {
    await env.DB.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL").bind(now, session.user.id).run();
    return json({ data: { status: "read_all" } });
  }
  const id = String(body.id || "").trim();
  if (!id) return json({ error: { code: "INVALID_NOTIFICATION", message: "Укажи уведомление." } }, 400);
  const result = await env.DB.prepare("UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL").bind(now, id, session.user.id).run();
  if (!result.meta?.changes) return json({ error: { code: "NOTIFICATION_NOT_FOUND", message: "Уведомление не найдено или уже прочитано." } }, 404);
  return json({ data: { id, read_at: now } });
}

export function onRequestPost() { return methodNotAllowed("GET, PUT"); }
export function onRequestDelete() { return methodNotAllowed("GET, PUT"); }
