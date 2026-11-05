import { json, methodNotAllowed } from "./_lib/http.js";
import { sameOrigin } from "./_lib/session-auth.js";
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
  const result = await lookupMlbbPlayer(env, gameId, zoneId);
  if (!result.ok) return json({ error: { code: result.code, message: result.message } }, result.status, { "cache-control": "no-store" });
  return json({ data: { game_id: result.gameId, server_id: result.zoneId, nickname: result.nickname, verified: true } }, 200, { "cache-control": "no-store" });
}

export function onRequestGet() { return methodNotAllowed("POST"); }
