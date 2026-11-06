import { json, databaseUnavailable } from "../../_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const url = new URL(request.url);
  const seasonId = String(url.searchParams.get("season_id") || "").trim();
  const teamId = String(url.searchParams.get("team_id") || "").trim();
  if (!seasonId) return json({error:{code:"SEASON_REQUIRED",message:"Укажи ID сезона."}},400);
  try {
    const season = await env.DB.prepare("SELECT id,title,season_number,status,starts_at,ends_at FROM seasons WHERE id=? LIMIT 1").bind(seasonId).first();
    if (!season) return json({error:{code:"SEASON_NOT_FOUND",message:"Сезон не найден."}},404);
    const filter = teamId ? " AND r.team_id=?" : "";
    const bindings = teamId ? [seasonId,teamId] : [seasonId];
    const {results: results} = await env.DB.prepare(
      "SELECT r.id,r.tournament_id,r.team_id,r.placement,r.placement_group,r.points_awarded,r.is_qualifier,r.finalized_at,t.title AS tournament_title,t.format,tm.name AS team_name,tm.tag AS team_tag,tm.logo_url AS team_logo " +
      "FROM circuit_tournament_results r JOIN tournaments t ON t.id=r.tournament_id JOIN teams tm ON tm.id=r.team_id " +
      "WHERE r.season_id=?"+filter+" ORDER BY r.finalized_at DESC,r.placement ASC"
    ).bind(...bindings).all();
    const ledgerFilter = teamId ? " AND tx.team_id=?" : "";
    const ledgerBindings = teamId ? [seasonId,teamId] : [seasonId];
    const {results: transactions} = await env.DB.prepare(
      "SELECT tx.id,tx.team_id,tx.tournament_id,tx.result_id,tx.points_delta,tx.transaction_type,tx.reason,tx.created_at,tm.name AS team_name,tm.tag AS team_tag,t.title AS tournament_title " +
      "FROM circuit_point_transactions tx JOIN teams tm ON tm.id=tx.team_id JOIN tournaments t ON t.id=tx.tournament_id " +
      "WHERE tx.season_id=?"+ledgerFilter+" ORDER BY tx.created_at DESC,tx.id DESC LIMIT 200"
    ).bind(...ledgerBindings).all();
    const eligible = (results||[]).filter(row=>Number(row.is_qualifier)!==1);
    const achievements = new Map();
    for (const row of eligible) {
      const key=String(row.team_id);
      if(!achievements.has(key)) achievements.set(key,{team_id:row.team_id,team_name:row.team_name,team_tag:row.team_tag,team_logo:row.team_logo,tournaments:0,championships:0,runner_ups:0,top_four:0,points:0});
      const item=achievements.get(key);
      item.tournaments++;
      item.points+=Number(row.points_awarded||0);
      if(Number(row.placement)===1)item.championships++;
      if(Number(row.placement)===2)item.runner_ups++;
      if(Number(row.placement)<=4)item.top_four++;
    }
    return json({season,results:results||[],transactions:transactions||[],achievements:[...achievements.values()].sort((a,b)=>b.championships-a.championships||b.top_four-a.top_four||b.points-a.points)});
  } catch(error) {
    console.error("MERCY CIRCUIT history failed:",error);
    return json({error:{code:"CIRCUIT_HISTORY_FAILED",message:"Не удалось загрузить историю MERCY CIRCUIT. Проверь миграцию 0018."}},500);
  }
}
