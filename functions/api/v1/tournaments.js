import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const tournamentId = url.searchParams.get("id");
  if (tournamentId && /^\d+$/.test(tournamentId)) {
    const item = await env.DB.prepare("SELECT t.id,t.title,t.description,t.game,t.region,t.format,t.status,t.max_teams,t.registration_open_at,t.registration_close_at,t.starts_at,t.ends_at,t.rules_url,t.season_id,t.published_at,(SELECT COUNT(*) FROM tournament_registrations r WHERE r.tournament_id=t.id AND r.status='approved') AS registered_teams FROM tournaments t WHERE t.id=? AND t.published_at IS NOT NULL AND t.status!='draft' LIMIT 1").bind(Number(tournamentId)).first();
    return json({data:item?[item]:[],limit:1});
  }
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