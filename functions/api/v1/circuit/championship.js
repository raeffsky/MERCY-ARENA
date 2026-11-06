import { json, databaseUnavailable } from "../_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url=new URL(request.url);
  const seasonId=String(url.searchParams.get("season_id")||"").trim();
  if(!seasonId)return json({error:{code:"SEASON_REQUIRED",message:"Укажи ID сезона."}},400);
  try{
    const season=await env.DB.prepare("SELECT id,title,season_number,status FROM seasons WHERE id=? LIMIT 1").bind(seasonId).first();
    if(!season)return json({error:{code:"SEASON_NOT_FOUND",message:"Сезон не найден."}},404);
    const {results:entries}=await env.DB.prepare(
      "SELECT e.id,e.team_id,e.qualification_source,e.source_id,e.seed,e.status,e.qualified_at,t.name AS team_name,t.tag AS team_tag,t.logo_url AS team_logo,t.region AS team_region " +
      "FROM circuit_championship_entries e JOIN teams t ON t.id=e.team_id WHERE e.season_id=? ORDER BY e.seed"
    ).bind(seasonId).all();
    const {results:qualifiers}=await env.DB.prepare(
      "SELECT q.id,q.qualifier_number,q.tournament_id,q.status,q.winner_team_id,q.finalized_at,t.title AS tournament_title,t.status AS tournament_status " +
      "FROM circuit_qualifiers q JOIN tournaments t ON t.id=q.tournament_id WHERE q.season_id=? ORDER BY q.qualifier_number"
    ).bind(seasonId).all();
    const slots=Array.from({length:8},(_,index)=>{
      const seed=index+1;
      const entry=(entries||[]).find(row=>Number(row.seed)===seed);
      return entry?{seed,status:entry.status,qualification_source:entry.qualification_source,team:{id:entry.team_id,name:entry.team_name,tag:entry.team_tag,logo_url:entry.team_logo,region:entry.team_region}}:
        {seed,status:"pending",qualification_source:seed<=6?"ranking":"qualifier",team:null};
    });
    return json({season,slots,qualifiers:qualifiers||[],qualified_count:(entries||[]).length,championship_ready:slots.every(slot=>slot.team&&["qualified","confirmed"].includes(slot.status))});
  }catch(error){
    console.error("MERCY CHAMPIONSHIP failed:",error);
    return json({error:{code:"CHAMPIONSHIP_FAILED",message:"Не удалось загрузить MERCY CHAMPIONSHIP. Проверь миграцию 0018."}},500);
  }
}
