import { json, databaseUnavailable, parseLimit, publicList } from "./_lib/http.js";

async function hasTournamentColumn(db, name) {
  const { results } = await db.prepare("PRAGMA table_info(tournaments)").all();
  return (results || []).some((column) => column.name === name);
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const tournamentId = url.searchParams.get("id");
  if (tournamentId) {
    const detailSql = "SELECT t.id,t.title,t.description,t.game,t.region,t.format,t.status,t.max_teams,t.registration_open_at,t.registration_close_at," +
      (await hasTournamentColumn(env.DB, "registration_slots") ? "t.registration_slots" : "NULL AS registration_slots") +
      ",t.starts_at,t.ends_at,t.rules_url,t.season_id,t.prize_pool,t.poster_url,t.stream_url,t.published_at,(SELECT COUNT(*) FROM tournament_registrations r JOIN teams registered_team ON registered_team.id=r.team_id AND registered_team.status='active' AND registered_team.archived_at IS NULL WHERE r.tournament_id=t.id AND r.status='approved') AS registered_teams,(SELECT COUNT(*) FROM tournament_registrations r JOIN teams applying_team ON applying_team.id=r.team_id AND applying_team.status='active' AND applying_team.archived_at IS NULL WHERE r.tournament_id=t.id AND r.status IN ('pending','approved')) AS occupied_slots FROM tournaments t WHERE t.id=? AND t.published_at IS NOT NULL AND t.status!='draft' LIMIT 1";
    const item = await env.DB.prepare(detailSql).bind(tournamentId).first();
    if (!item) return json({data:[],limit:1});
    const { results: registeredTeams } = await env.DB.prepare("SELECT tm.id,tm.name,tm.tag,tm.logo_url,tm.region FROM tournament_registrations r JOIN teams tm ON tm.id=r.team_id AND tm.status='active' AND tm.archived_at IS NULL WHERE r.tournament_id=? AND r.status='approved' ORDER BY tm.name COLLATE NOCASE").bind(tournamentId).all();
    return json({data:[{...item,registered_teams_list:registeredTeams||[]}],limit:1});
  }
  const status = url.searchParams.get("status");
  const format = url.searchParams.get("format");
  const seasonId = url.searchParams.get("season_id");
  const where = ["published_at IS NOT NULL", "status != 'draft'"];
  const values = [];
  if (status) { where.push("status = ?"); values.push(status); }
  if (format) { where.push("format = ?"); values.push(format); }
  if (seasonId) { where.push("season_id = ?"); values.push(seasonId); }
  const hasSlots = await hasTournamentColumn(env.DB, "registration_slots");
  const fields = "id,title,description,game,region,format,status,max_teams,registration_open_at,registration_close_at," +
    (hasSlots ? "registration_slots" : "NULL AS registration_slots") +
    ",starts_at,ends_at,rules_url,season_id,prize_pool,poster_url,published_at,created_at,updated_at," +
    "(SELECT COUNT(*) FROM tournament_registrations r JOIN teams applying_team ON applying_team.id=r.team_id AND applying_team.status='active' AND applying_team.archived_at IS NULL WHERE r.tournament_id=tournaments.id AND r.status IN ('pending','approved')) AS occupied_slots";
  const stmt = env.DB.prepare(`SELECT ${fields} FROM tournaments WHERE ${where.join(" AND ")} ORDER BY starts_at IS NULL, starts_at ASC, published_at DESC LIMIT ?`).bind(...values, limit);
  const { results } = await stmt.all();
  return json(publicList(results || [], limit));
}