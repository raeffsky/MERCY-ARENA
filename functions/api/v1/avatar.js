import { json } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = {
  "image/jpeg": { ext: "jpg", valid: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", valid: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/webp": { ext: "webp", valid: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 }
};

function storageUnavailable(env) {
  return !env.AVATARS ? json({ error: { code: "AVATAR_STORAGE_NOT_CONFIGURED", message: "Хранилище фотографий ещё не подключено." } }, 503) : null;
}
function objectKey(url) {
  const key = url.searchParams.get("key") || "";
  return /^players\/\d+\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(key) ? key : "";
}

export async function onRequestGet({ request, env }) {
  const unavailable = storageUnavailable(env); if (unavailable) return unavailable;
  const key = objectKey(new URL(request.url));
  if (!key) return json({ error: { code: "AVATAR_NOT_FOUND", message: "Фотография не найдена." } }, 404);
  const object = await env.AVATARS.get(key);
  if (!object) return json({ error: { code: "AVATAR_NOT_FOUND", message: "Фотография не найдена." } }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

export async function onRequestPut({ request, env }) {
  const unavailable = storageUnavailable(env); if (unavailable) return unavailable;
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const session = await getSessionUser(request, env);
  if (session.error) return session.error;
  if (!session.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт, чтобы загрузить фото." } }, 401);
  const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const type = TYPES[contentType];
  if (!type) return json({ error: { code: "INVALID_AVATAR_TYPE", message: "Поддерживаются только JPG, PNG и WebP." } }, 415);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BYTES) return json({ error: { code: "AVATAR_TOO_LARGE", message: "Размер фотографии не должен превышать 5 МБ." } }, 413);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return json({ error: { code: "AVATAR_TOO_LARGE", message: "Выбери фотографию размером до 5 МБ." } }, 413);
  if (!type.valid(new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)))) return json({ error: { code: "INVALID_AVATAR_FILE", message: "Файл не похож на изображение выбранного формата." } }, 415);
  const profile = await env.DB.prepare("SELECT id,avatar_url FROM players WHERE user_id=? LIMIT 1").bind(session.user.id).first();
  if (!profile) return json({ error: { code: "PROFILE_REQUIRED", message: "Сначала создай игровой профиль." } }, 409);
  const key = "players/" + String(session.user.id) + "/" + crypto.randomUUID() + "." + type.ext;
  await env.AVATARS.put(key, bytes, { httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" } });
  const avatarUrl = "/api/v1/avatar?key=" + encodeURIComponent(key);
  try {
    await env.DB.prepare("UPDATE players SET avatar_url=?,updated_at=? WHERE user_id=?").bind(avatarUrl, new Date().toISOString(), session.user.id).run();
  } catch (error) {
    await env.AVATARS.delete(key).catch(() => {});
    throw error;
  }
  const previousKey = profile.avatar_url ? objectKey(new URL(profile.avatar_url, request.url)) : "";
  if (previousKey) await env.AVATARS.delete(previousKey).catch(() => {});
  return json({ data: { avatar_url: avatarUrl } });
}

export async function onRequestDelete({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const session = await getSessionUser(request, env);
  if (session.error) return session.error;
  if (!session.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт." } }, 401);
  const profile = await env.DB.prepare("SELECT avatar_url FROM players WHERE user_id=? LIMIT 1").bind(session.user.id).first();
  const key = profile?.avatar_url ? objectKey(new URL(profile.avatar_url, request.url)) : "";
  await env.DB.prepare("UPDATE players SET avatar_url=NULL,updated_at=? WHERE user_id=?").bind(new Date().toISOString(), session.user.id).run();
  if (key && env.AVATARS) await env.AVATARS.delete(key).catch(() => {});
  return json({ data: { avatar_url: null } });
}
