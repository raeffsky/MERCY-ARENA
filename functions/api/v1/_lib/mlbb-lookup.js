const BASE_URL = "https://api.zapi.ink/v1/games:mlbb/profile";

export async function lookupMlbbPlayer(env, gameId, zoneId) {
  const apiKey = String(env.MLBB_LOOKUP_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, status: 503, code: "MLBB_LOOKUP_NOT_CONFIGURED", message: "Автопроверка MLBB пока не подключена. Администратор должен добавить API-ключ проверки." };
  }
  const url = new URL(env.MLBB_LOOKUP_URL || BASE_URL);
  url.searchParams.set("gameId", gameId);
  url.searchParams.set("zoneId", zoneId);
  let response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": apiKey, "accept": "application/json" },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    console.error("MLBB lookup network error:", error);
    return { ok: false, status: 502, code: "MLBB_LOOKUP_UNAVAILABLE", message: "Сервис проверки MLBB временно недоступен. Попробуй позже." };
  }
  if (response.status === 404) return { ok: false, status: 422, code: "MLBB_PLAYER_NOT_FOUND", message: "Аккаунт с таким ID и Server ID не найден или профиль закрыт." };
  if (response.status === 401 || response.status === 403) {
    console.error("MLBB lookup provider rejected the API key:", response.status);
    return { ok: false, status: 503, code: "MLBB_LOOKUP_AUTH_FAILED", message: "Сервис проверки MLBB не принял API-ключ. Обратись к администратору." };
  }
  if (response.status === 429) return { ok: false, status: 503, code: "MLBB_LOOKUP_RATE_LIMITED", message: "Сервис проверки перегружен. Попробуй позже." };
  if (!response.ok) {
    console.error("MLBB lookup provider HTTP error:", response.status);
    return { ok: false, status: 502, code: "MLBB_LOOKUP_PROVIDER_ERROR", message: "Не удалось проверить игровой аккаунт. Попробуй позже." };
  }
  let payload;
  try { payload = await response.json(); } catch {
    return { ok: false, status: 502, code: "MLBB_LOOKUP_INVALID_RESPONSE", message: "Сервис проверки вернул некорректный ответ." };
  }
  const data = payload?.data || payload?.content || payload?.result || payload;
  const player = data?.player_data || data?.player || data;
  const nickname = String(player?.username || player?.nickname || player?.name || "").trim().slice(0, 32);
  const returnedId = String(player?.gameId ?? player?.player_id ?? player?.user_id ?? data?.gameId ?? data?.player_id ?? gameId);
  const returnedZone = String(player?.zoneId ?? player?.server_id ?? player?.zone ?? data?.zoneId ?? data?.zone ?? zoneId);
  const verified = player?.verified === true || data?.verified === true;
  if (!nickname || !verified || returnedId !== gameId || returnedZone !== zoneId) {
    return { ok: false, status: 422, code: "MLBB_PLAYER_UNVERIFIED", message: "Не удалось подтвердить этот игровой аккаунт. Проверь ID и Server ID." };
  }
  return { ok: true, nickname, gameId, zoneId };
}
