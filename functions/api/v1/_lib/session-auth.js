import { json } from "./http.js";

const SESSION_SECONDS = 60 * 60 * 24 * 14;
export const SESSION_TTL = SESSION_SECONDS;

export function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizedEmail(value) { return String(value || "").trim().toLowerCase().slice(0, 254); }
export function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

export function cookieValue(request, name) {
  const item = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return item ? item.slice(name.length + 1) : "";
}
export function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return "mercy_session=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}
export function clearSessionCookie() { return "mercy_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }
export function sameOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(env.APP_BASE_URL || request.url).origin; } catch { return false; }
}

export function isOwnerAccount(user, env) {
  const ownerEmail = normalizedEmail(env && env.BOOTSTRAP_ADMIN_EMAIL);
  return !!(user && ownerEmail && normalizedEmail(user.email) === ownerEmail);
}

export async function getSessionUser(request, env) {
  if (!env.DB) return { error: json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных не подключена." } }, 503) };
  const token = cookieValue(request, "mercy_session");
  if (!token) return { user: null };
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT u.id,u.email,u.display_name FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? LIMIT 1").bind(tokenHash, now).first();
  if (!row) return { user: null };
  const roles = await env.DB.prepare("SELECT role FROM user_roles WHERE user_id=? ORDER BY role").bind(row.id).all();
  return { user: { ...row, roles: (roles.results || []).map((item) => item.role) } };
}
