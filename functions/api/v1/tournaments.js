import { json, databaseUnavailable, parseLimit, publicList, methodNotAllowed } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const status = url.searchParams.get("status");
  const format = url.searchParams.get("format");
  const where = ["published_at IS NOT NULL", "status != 'draft'"];
  const values = [];
  if (status) { where.push("status = ?"); values.push(status); }
  if (format) { where.push("format = ?"); values.push(format); }
  const stmt = env.DB.prepare(`SELECT id,title,description,game,region,format,status,max_teams,registration_open_at,registration_close_at,starts_at,ends_at,rules_url,season_id,published_at,created_at,updated_at FROM tournaments WHERE ${where.join(" AND ")} ORDER BY starts_at IS NULL, starts_at ASC, published_at DESC LIMIT ?`).bind(...values, limit);
  const { results } = await stmt.all();
  return json(publicList(results || [], limit));
}
export function onRequest({ request }) { return request.method === "GET" ? null : methodNotAllowed(); }
