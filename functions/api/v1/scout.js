import { json, databaseUnavailable, parseLimit } from "./_lib/http.js";
export async function onRequestGet({request,env}) {
  if(!env.DB)return databaseUnavailable();
  const url=new URL(request.url),limit=parseLimit(url,50,100),query=String(url.searchParams.get("query")||"").trim().slice(0,80),role=String(url.searchParams.get("role")||"").trim().toUpperCase(),region=String(url.searchParams.get("region")||"").trim().slice(0,80),sort=url.searchParams.get("sort")||"points";
  if(role&&!["EXP","JUNGLE","MID","GOLD","ROAM","FLEX"].includes(role))return json({error:{code:"INVALID_ROLE",message:"Выбери одну из доступных ролей MLBB."}},400);
  const order=({points:"points DESC,wins DESC,win_rate DESC",win_rate:"win_rate DESC,matches_played DESC,wins DESC",matches:"matches_played DESC,win_rate DESC",newest:"p.created_at DESC"})[sort]||"points DESC,wins DESC,win_rate DESC";
  const where=["p.profile_status='approved'","p.archived_at IS NULL"],values=[];
  if(query){where.push("(p.nickname LIKE ? OR p.game_id LIKE ? OR t.name LIKE ? OR t.tag LIKE ?)");values.push("%"+query+"%","%"+query+"%","%"+query+"%","%"+query+"%")}
  if(role){where.push("p.role=?");values.push(role)}
  if(region){where.push("p.region=?");values.push(region)}
  const {results}=await env.DB.prepare(`
    WITH player_matches AS (
      SELECT DISTINCT p0.id AS player_id,m.id AS match_id,m.winner_team_id,r.team_id
      FROM tournament_registration_roster rr JOIN players p0 ON p0.id=rr.player_id
      JOIN tournament_registrations r ON r.id=rr.registration_id AND r.status='approved'
      JOIN matches m ON m.tournament_id=r.tournament_id AND (m.team_a_id=r.team_id OR m.team_b_id=r.team_id)
      JOIN tournaments tour ON tour.id=m.tournament_id AND tour.published_at IS NOT NULL AND tour.status!='draft'
      WHERE rr.roster_role='starter' AND m.status='completed' AND m.result_verified_at IS NOT NULL
    )
    SELECT p.id,p.nickname,p.game_id,p.role,p.region,p.avatar_url,p.team_id,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo,
      COUNT(pm.match_id) AS matches_played,COALESCE(SUM(CASE WHEN pm.winner_team_id=pm.team_id THEN 1 ELSE 0 END),0) AS wins,
      COALESCE(SUM(CASE WHEN pm.winner_team_id=pm.team_id THEN 3 ELSE 0 END),0) AS points,
      COALESCE(SUM(CASE WHEN pm.winner_team_id IS NOT NULL AND pm.winner_team_id!=pm.team_id THEN 1 ELSE 0 END),0) AS losses,
      COALESCE(ROUND(100.0*SUM(CASE WHEN pm.winner_team_id=pm.team_id THEN 1 ELSE 0 END)/NULLIF(COUNT(pm.match_id),0),1),0) AS win_rate,p.created_at
    FROM players p LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN player_matches pm ON pm.player_id=p.id
    WHERE ${where.join(" AND ")} GROUP BY p.id ORDER BY ${order},p.nickname COLLATE NOCASE LIMIT ?
  `).bind(...values,limit).all();
  const {results:regions}=await env.DB.prepare("SELECT DISTINCT region FROM players WHERE profile_status='approved' AND archived_at IS NULL AND region IS NOT NULL AND region!='' ORDER BY region COLLATE NOCASE LIMIT 100").all();
  return json({data:results||[],meta:{count:(results||[]).length,limit,regions:(regions||[]).map(x=>x.region),sort,scoring:"Только подтверждённые матчи и игроки стартового состава."}});
}
