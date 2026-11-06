import { json } from "../_lib/http.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "../_lib/session-auth.js";

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function authorize(request, env) {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return { response: json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "Cloudinary ещё не подключён." } }, 503) };
  }
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return { response: json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403) };
  const session = await getSessionUser(request, env);
  if (session.error) return { response: session.error };
  if (!session.user || !session.user.roles.includes("administrator") || !isOwnerAccount(session.user, env)) return { response: json({ error: { code: "FORBIDDEN", message: "Доступ к кабинету организатора закрыт." } }, 403) };
  return {};
}
function hex(buffer) { return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join(""); }
async function signature(timestamp, folder, secret) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode("folder=" + folder + "&timestamp=" + timestamp + secret));
  return hex(digest);
}
export async function onRequestPost({ request, env }) {
  const auth = await authorize(request, env);
  if (auth.response) return auth.response;
  let form;
  try { form = await request.formData(); } catch { return json({ error: { code: "INVALID_FORM", message: "Не удалось прочитать файл." } }, 400); }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") return json({ error: { code: "FILE_REQUIRED", message: "Выберите изображение." } }, 400);
  if (!TYPES.has(file.type)) return json({ error: { code: "UNSUPPORTED_IMAGE", message: "Поддерживаются только JPG, PNG и WebP." } }, 415);
  if (!file.size || file.size > MAX_BYTES) return json({ error: { code: "FILE_TOO_LARGE", message: "Размер изображения должен быть не больше 8 МБ." } }, 413);
  const timestamp = Math.floor(Date.now() / 1000).toString(), folder = "mercy-arena/seasons";
  const upload = new FormData();
  upload.set("file", file, "season-cover.jpg");
  upload.set("api_key", env.CLOUDINARY_API_KEY);
  upload.set("timestamp", timestamp);
  upload.set("folder", folder);
  upload.set("signature", await signature(timestamp, folder, env.CLOUDINARY_API_SECRET));
  try {
    const response = await fetch("https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/image/upload", { method: "POST", body: upload });
    const result = await response.json();
    if (!response.ok) return json({ error: { code: "CLOUDINARY_UPLOAD_FAILED", message: result?.error?.message || "Cloudinary отклонил загрузку." } }, 502);
    return json({ data: { url: result.secure_url, public_id: result.public_id, width: result.width, height: result.height } }, 201);
  } catch { return json({ error: { code: "CLOUDINARY_UNAVAILABLE", message: "Не удалось связаться с Cloudinary." } }, 502); }
}
