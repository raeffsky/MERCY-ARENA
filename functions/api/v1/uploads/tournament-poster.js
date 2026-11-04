import { json } from "../_lib/http.js";
import { getSessionUser, sameOrigin } from "../_lib/session-auth.js";

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function authorize(request, env) {
  if (!env.MEDIA) return { response: json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "Хранилище изображений не подключено. Добавьте R2 binding MEDIA в Cloudflare Pages." } }, 503) };
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return { response: json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403) };
  const session = await getSessionUser(request, env);
  if (session.error) return { response: session.error };
  if (!session.user || !session.user.roles.includes("administrator")) return { response: json({ error: { code: "FORBIDDEN", message: "Требуются права администратора." } }, 403) };
  return {};
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
  const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[file.type];
  const key = "tournament-posters/" + crypto.randomUUID() + "." + extension;
  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" }
  });
  return json({ data: { url: "/api/v1/uploads/tournament-poster?key=" + encodeURIComponent(key), key, size: file.size } }, 201);
}

export async function onRequestGet({ request, env }) {
  if (!env.MEDIA) return new Response("Media storage is not configured.", { status: 503 });
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!/^tournament-posters\/[a-f0-9-]+\.(jpg|png|webp)$/.test(key)) return new Response("Not found", { status: 404 });
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
