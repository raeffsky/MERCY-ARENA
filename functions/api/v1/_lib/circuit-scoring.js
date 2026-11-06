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
