import { json, methodNotAllowed } from "../_lib/http.js";
import { normalizedEmail, validEmail, randomToken, sha256, sameOrigin } from "../_lib/session-auth.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных не подключена." } }, 503);
  if (!sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  if (!env.BREVO_API_KEY || !env.AUTH_FROM_EMAIL || !env.APP_BASE_URL || !env.BOOTSTRAP_ADMIN_EMAIL) {
    return json({ error: { code: "AUTH_NOT_CONFIGURED", message: "Вход по почте ещё не настроен на сервере." } }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Проверьте формат запроса." } }, 400); }
  const email = normalizedEmail(body.email);
  if (!validEmail(email)) return json({ error: { code: "INVALID_EMAIL", message: "Укажите корректный email." } }, 400);

  const bootstrapEmail = normalizedEmail(env.BOOTSTRAP_ADMIN_EMAIL);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  if (email === bootstrapEmail || existing) {
    const emailHash = await sha256(email);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipHash = await sha256(ip + String(env.AUTH_RATE_LIMIT_SALT || env.APP_BASE_URL));
    const limits = await env.DB.prepare("SELECT SUM(CASE WHEN email_hash=? THEN 1 ELSE 0 END) AS email_count, SUM(CASE WHEN ip_hash=? THEN 1 ELSE 0 END) AS ip_count FROM auth_magic_links WHERE created_at >= datetime('now','-15 minutes')").bind(emailHash, ipHash).first();
    if ((limits?.email_count || 0) >= 4 || (limits?.ip_count || 0) >= 12) return json({ message: "Если адрес разрешён для входа, ссылка будет отправлена." });

    const token = randomToken(32);
    const tokenHash = await sha256(token);
    await env.DB.prepare("INSERT INTO auth_magic_links (id,email,token_hash,email_hash,ip_hash,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), email, tokenHash, emailHash, ipHash, Math.floor(Date.now() / 1000) + 900).run();
    const link = String(env.APP_BASE_URL).replace(/\/$/, "") + "/api/v1/auth/verify?token=" + encodeURIComponent(token);
    const safeLink = link.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const sent = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "MERCY ARENA", email: env.AUTH_FROM_EMAIL },
        to: [{ email }],
        subject: "Вход в MERCY ARENA",
        textContent: "Ссылка для входа (действует 15 минут): " + link + "\nЕсли вы не запрашивали вход, проигнорируйте это письмо.",
        htmlContent: '<div style="background:#08090d;color:#f5f6fa;padding:32px;font-family:Arial,sans-serif"><h1 style="color:#d7ff5e">MERCY ARENA</h1><p>Вы запросили вход в кабинет.</p><p><a href="' + safeLink + '" style="display:inline-block;background:#d7ff5e;color:#08090d;padding:14px 20px;text-decoration:none;font-weight:bold">ВОЙТИ В MERCY ARENA</a></p><p>Ссылка действует 15 минут и используется один раз.</p><p style="color:#9ba2af;font-size:12px">Если вы не запрашивали вход, проигнорируйте это письмо.</p></div>'
      })
    });
    if (!sent.ok) {
      await env.DB.prepare("DELETE FROM auth_magic_links WHERE token_hash=?").bind(tokenHash).run();
      return json({ error: { code: "EMAIL_DELIVERY_FAILED", message: "Не удалось отправить письмо. Проверьте настройки почтового сервиса." } }, 502);
    }
  }
  return json({ message: "Если адрес разрешён для входа, ссылка будет отправлена." });
}
export function onRequestGet() { return methodNotAllowed("POST"); }
