import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const query = (url.searchParams.get("query") || "").trim().slice(0, 80);
  const role = url.searchParams.get("role");
  const clauses = ["1 = 1"];
  const values = [];
  if (query) { clauses.push("nickname LIKE ?"); values.push(`%${query}%`); }
  if (role) { clauses.push("role = ?"); values.push(role); }
  const { results } = await env.DB.prepare(`SELECT id,nickname,game_id,role,team_id,region,created_at FROM players WHERE ${clauses.join(" AND ")} ORDER BY nickname COLLATE NOCASE LIMIT ?`).bind(...values, limit).all();
  return json(publicList(results || [], limit));
}
