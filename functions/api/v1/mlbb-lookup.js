import { json, methodNotAllowed } from "./_lib/http.js";
import { sameOrigin, sha256 } from "./_lib/session-auth.js";
import { lookupMlbbPlayer } from "./_lib/mlbb-lookup.js";

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) {
    return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  }
  let body;
  try { body = await request.json(); } catch {
    return json({ error: { code: "INVALID_JSON", message: "Некорректные данные." } }, 400);
  }
  const gameId = String(body?.game_id || "").trim();
  const zoneId = String(body?.server_id || "").trim();
  if (!/^\d{5,15}$/.test(gameId) || !/^\d{1,6}$/.test(zoneId)) {
    return json({ error: { code: "INVALID_MLBB_ID", message: "Укажи корректные MLBB ID и Server ID." } }, 400);
  }
  if (!env.DB) return json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных не подключена." } }, 503);
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const salt = String(env.AUTH_RATE_LIMIT_SALT || env.APP_BASE_URL || "mercy-arena");
  const ipHash = await sha256(ip + salt + ":mlbb-lookup");
  const lookupHash = await sha256("mlbb-lookup:" + gameId + ":" + zoneId);
  await env.DB.prepare("DELETE FROM auth_login_attempts WHERE attempted_at<=?").bind(now - 3600).run();
  const attempts = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM auth_login_attempts WHERE (ip_hash=? OR email_hash=?) AND attempted_at>?"
  ).bind(ipHash, lookupHash, now - 900).first();
  if ((attempts?.total || 0) >= 40) {
    return json({ error: { code: "LOOKUP_RATE_LIMITED", message: "Слишком много проверок. Подожди 15 минут и попробуй снова." } }, 429);
  }
  await env.DB.prepare(
    "INSERT INTO auth_login_attempts (id,email_hash,ip_hash,attempted_at) VALUES (?,?,?,?)"
  ).bind(crypto.randomUUID(), lookupHash, ipHash, now).run();
  const result = await lookupMlbbPlayer(env, gameId, zoneId);
  if (!result.ok) return json({ error: { code: result.code, message: result.message } }, result.status, { "cache-control": "no-store" });
  return json({ data: { game_id: result.gameId, server_id: result.zoneId, nickname: result.nickname, verified: true } }, 200, { "cache-control": "no-store" });
}

export function onRequestGet() { return methodNotAllowed("POST"); }
