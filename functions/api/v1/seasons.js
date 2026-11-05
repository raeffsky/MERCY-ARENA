import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const limit = parseLimit(new URL(request.url));
  const { results } = await env.DB.prepare("SELECT id,title,starts_at,ends_at,status,image_url,created_at FROM seasons WHERE status != 'draft' ORDER BY starts_at DESC LIMIT ?").bind(limit).all();
  return json(publicList(results || [], limit));
}
