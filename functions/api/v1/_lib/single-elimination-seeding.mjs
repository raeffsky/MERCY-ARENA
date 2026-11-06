export function buildSingleEliminationSeeding(teamIds) {
  const teams = Array.isArray(teamIds) ? teamIds : [];
  if (teams.length < 2) throw new Error("At least two teams are required");
  const size = 2 ** Math.ceil(Math.log2(teams.length));
  if (size > 32) throw new Error("Single Elimination supports at most 32 teams");

  let seedOrder = [1];
  for (let bracketSize = 2; bracketSize <= size; bracketSize *= 2) {
    seedOrder = seedOrder.flatMap((seed) => [seed, bracketSize + 1 - seed]);
  }

  const firstRoundSlots = seedOrder.map((seed) => seed <= teams.length ? teams[seed - 1] : null);
  const firstRoundPairs = Array.from({ length: size / 2 }, (_, index) => {
    const teamA = firstRoundSlots[index * 2];
    const teamB = firstRoundSlots[index * 2 + 1];
    return {
      match_number: index + 1,
      team_a_id: teamA,
      team_b_id: teamB,
      bye_team_id: teamA == null ? teamB : teamB == null ? teamA : null
    };
  });

  return { size, rounds: Math.log2(size), firstRoundSlots, firstRoundPairs };
}
