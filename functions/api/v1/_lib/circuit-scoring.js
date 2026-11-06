export function placementGroup(placement) {
  const place = Number(placement);
  if (!Number.isSafeInteger(place) || place < 1) throw new Error("Invalid placement");
  if (place === 1) return "1";
  if (place === 2) return "2";
  if (place <= 4) return "3-4";
  if (place <= 8) return "5-8";
  if (place <= 16) return "9-16";
  return "participation";
}

export function defaultPlacementPoints(placement) {
  const group = placementGroup(placement);
  return ({ "1": 100, "2": 75, "3-4": 55, "5-8": 25, "9-16": 10, participation: 5 })[group];
}

export function pointsForPlacement(placement, rules = []) {
  const place = Number(placement);
  if (!Number.isSafeInteger(place) || place < 1) throw new Error("Invalid placement");
  const rule = rules.find((item) => place >= Number(item.place_from) && place <= Number(item.place_to));
  return rule ? Number(rule.points) : defaultPlacementPoints(place);
}

export function compareCircuitTeams(a, b) {
  const fields = ["points", "first_places", "second_places", "top_four_finishes", "verified_wins"];
  for (const field of fields) {
    const difference = Number(b[field] || 0) - Number(a[field] || 0);
    if (difference) return difference;
  }
  return String(a.team_name || "").localeCompare(String(b.team_name || ""), "ru");
}

export function buildCircuitRanking(rows) {
  return [...rows].sort(compareCircuitTeams).map((row, index) => ({ ...row, rank: index + 1 }));
}

export function deriveSingleEliminationPlacements(matches) {
  const completed = matches.filter((match) => match.status === "completed" && match.winner_team_id != null);
  if (!completed.length) throw new Error("Tournament has no completed matches");
  const rounds = [...new Set(completed.filter((m) => m.bracket === "main").map((m) => Number(m.round_number)))].sort((a,b)=>a-b);
  const finalRound = Math.max(...rounds);
  const final = completed.find((m) => m.bracket === "main" && Number(m.round_number) === finalRound);
  if (!final || final.team_a_id == null || final.team_b_id == null) throw new Error("Single Elimination final is incomplete");
  const placements = [
    { team_id: String(final.winner_team_id), placement: 1 },
    { team_id: String(String(final.team_a_id) === String(final.winner_team_id) ? final.team_b_id : final.team_a_id), placement: 2 }
  ];
  for (let round = finalRound - 1; round >= 1; round--) {
    const eliminated = completed.filter((m) => m.bracket === "main" && Number(m.round_number) === round)
      .map((m) => {
        if (m.team_a_id == null || m.team_b_id == null) throw new Error("Single Elimination contains an unresolved match");
        return String(String(m.team_a_id) === String(m.winner_team_id) ? m.team_b_id : m.team_a_id);
      });
    if (!eliminated.length) continue;
    const first = placements.length + 1;
    eliminated.forEach((team_id, index) => placements.push({ team_id, placement: first + index }));
  }
  return placements;
}

export function deriveRoundRobinPlacements(matches) {
  const completed = matches.filter((match) => match.bracket === "group" && match.status === "completed" && match.winner_team_id != null);
  const teams = new Map();
  for (const match of completed) {
    if (match.team_a_id == null || match.team_b_id == null || match.score_a == null || match.score_b == null) {
      throw new Error("Round Robin contains an incomplete result");
    }
    for (const id of [match.team_a_id, match.team_b_id]) {
      const key = String(id);
      if (!teams.has(key)) teams.set(key, { team_id: key, wins: 0, losses: 0, score_for: 0, score_against: 0, head_to_head_wins: 0 });
    }
    const a = teams.get(String(match.team_a_id)), b = teams.get(String(match.team_b_id));
    a.score_for += Number(match.score_a); a.score_against += Number(match.score_b);
    b.score_for += Number(match.score_b); b.score_against += Number(match.score_a);
    if (String(match.winner_team_id) === String(match.team_a_id)) { a.wins++; b.losses++; a.head_to_head_wins++; }
    else if (String(match.winner_team_id) === String(match.team_b_id)) { b.wins++; a.losses++; b.head_to_head_wins++; }
    else throw new Error("Round Robin winner is not a participant");
  }
  return [...teams.values()].sort((a,b) =>
    b.wins-a.wins || b.head_to_head_wins-a.head_to_head_wins ||
    (b.score_for-b.score_against)-(a.score_for-a.score_against) ||
    b.score_for-a.score_for || String(a.team_id).localeCompare(String(b.team_id),undefined,{numeric:true})
  ).map((team,index)=>({team_id:team.team_id,placement:index+1}));
}

export function deriveDoubleEliminationPlacements(matches) {
  const completed = matches.filter((match) => match.status === "completed" && match.winner_team_id != null);
  const finals = completed.filter((match) => match.bracket === "final").sort((a,b)=>Number(a.round_number)-Number(b.round_number));
  const firstFinal = finals.find((match)=>Number(match.round_number)===1);
  if (!firstFinal || firstFinal.team_a_id == null || firstFinal.team_b_id == null) throw new Error("Double Elimination grand final is incomplete");
  const reset = finals.find((match)=>Number(match.round_number)===2);
  const decisive = reset || firstFinal;
  const champion = String(decisive.winner_team_id);
  const runnerUp = String(String(decisive.team_a_id)===champion?decisive.team_b_id:decisive.team_a_id);
  const placements = [{team_id:champion,placement:1},{team_id:runnerUp,placement:2}];
  const lowerRounds = [...new Set(completed.filter((m)=>m.bracket==="lower").map((m)=>Number(m.round_number)))].sort((a,b)=>b-a);
  let eliminatedCount = 0;
  for (const round of lowerRounds) {
    const eliminated = completed.filter((m)=>m.bracket==="lower" && Number(m.round_number)===round).map((m)=>{
      if(m.team_a_id==null||m.team_b_id==null) throw new Error("Double Elimination contains an unresolved lower-bracket match");
      return String(String(m.team_a_id)===String(m.winner_team_id)?m.team_b_id:m.team_a_id);
    });
    if(!eliminated.length) continue;
    const first = 3 + eliminatedCount;
    eliminated.forEach((team_id,index)=>placements.push({team_id,placement:first+index}));
    eliminatedCount += eliminated.length;
  }
  const expected = new Set(matches.flatMap((m)=>[m.team_a_id,m.team_b_id]).filter((id)=>id!=null).map(String));
  const actual = new Set(placements.map((p)=>p.team_id));
  if (actual.size !== expected.size) throw new Error("Double Elimination placements do not cover every participating team");
  return placements;
}

export function deriveTournamentPlacements(format, matches) {
  if (format === "single_elimination") return deriveSingleEliminationPlacements(matches);
  if (format === "double_elimination") return deriveDoubleEliminationPlacements(matches);
  if (format === "round_robin") return deriveRoundRobinPlacements(matches);
  throw new Error("Unsupported MERCY CIRCUIT tournament format");
}
