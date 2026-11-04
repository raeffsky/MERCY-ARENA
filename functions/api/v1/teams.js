import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const query = (url.searchParams.get("query") || "").trim().slice(0, 80);
  const { results } = await env.DB.prepare(`SELECT id,name,tag,logo_url,region,status,created_at FROM teams WHERE status = 'active' AND (? = '' OR name LIKE ? OR tag LIKE ?) ORDER BY name COLLATE NOCASE LIMIT ?`).bind(query, `%${query}%`, `%${query}%`, limit).all();
  return json(publicList(results || [], limit));
}
