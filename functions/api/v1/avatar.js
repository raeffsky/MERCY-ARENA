import { json } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = {
  "image/jpeg": { ext: "jpg", valid: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", valid: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/webp": { ext: "webp", valid: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 }
};

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function cloudinarySignature(params, secret) {
  const canonical = Object.keys(params).sort().map((key) => key + "=" + params[key]).join("&") + secret;
  return hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(canonical)));
}
function configError(env) {
  return !env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET
    ? json({ error: { code: "CLOUDINARY_NOT_CONFIGURED", message: "Cloudinary ещё не настроен в переменных проекта." } }, 503)
    : null;
}

export async function onRequestPost({ request, env }) {
  const unavailable = configError(env); if (unavailable) return unavailable;
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

  const profile = await env.DB.prepare("SELECT id FROM players WHERE user_id=? LIMIT 1").bind(session.user.id).first();
  if (!profile) return json({ error: { code: "PROFILE_REQUIRED", message: "Сначала создай игровой профиль." } }, 409);

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder: "mercy-arena/players",
    overwrite: "false",
    public_id: "player-" + String(profile.id) + "-" + crypto.randomUUID(),
    timestamp: String(timestamp)
  };
  const signature = await cloudinarySignature(params, env.CLOUDINARY_API_SECRET);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: contentType }), "avatar." + type.ext);
  for (const [key, value] of Object.entries(params)) form.set(key, value);
  form.set("api_key", env.CLOUDINARY_API_KEY);
  form.set("signature", signature);

  let uploaded;
  try {
    const response = await fetch("https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/image/upload", { method: "POST", body: form });
    uploaded = await response.json();
    if (!response.ok || !uploaded.secure_url) {
      console.error("Cloudinary avatar upload failed:", uploaded.error?.message || response.status);
      return json({ error: { code: "CLOUDINARY_UPLOAD_FAILED", message: "Cloudinary не смог сохранить фотографию. Попробуй другой файл." } }, 502);
    }
  } catch (error) {
    console.error("Cloudinary avatar request failed:", error);
    return json({ error: { code: "CLOUDINARY_UNAVAILABLE", message: "Не удалось связаться с Cloudinary." } }, 502);
  }

  await env.DB.prepare("UPDATE players SET avatar_url=?,updated_at=? WHERE user_id=?").bind(uploaded.secure_url, new Date().toISOString(), session.user.id).run();
  return json({ data: { avatar_url: uploaded.secure_url, public_id: uploaded.public_id } });
}

export function onRequestGet() {
  return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Метод не поддерживается." } }, 405, { allow: "POST" });
}
