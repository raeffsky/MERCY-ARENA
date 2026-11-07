function loserOf(match) {
  if (match.winner_team_id == null || match.team_a_id == null || match.team_b_id == null) return null;
  const winner = String(match.winner_team_id);
  if (winner === String(match.team_a_id)) return String(match.team_b_id);
  if (winner === String(match.team_b_id)) return String(match.team_a_id);
  throw new Error("В зависимом матче найден победитель, который не участвовал в матче.");
}

function hasPlayedResult(match) {
  return match.status === "completed" || match.status === "in_progress" ||
    match.score_a != null || match.score_b != null || match.winner_team_id != null;
}

function assertSupportedTarget(match) {
  if (!match) throw new Error("Связанный матч не найден. Каскадная корректировка остановлена.");
  if (!["scheduled", "in_progress", "completed"].includes(match.status)) {
    throw new Error("Связанный матч отменён или перенесён. Сначала восстанови его расписание.");
  }
}

export async function prepareMatchCorrectionCascade(db, tournamentId, sourceMatch, newWinnerTeamId, timestamp) {
  const oldWinner = String(sourceMatch.winner_team_id ?? "");
  const newWinner = String(newWinnerTeamId ?? "");
  if (!oldWinner || !newWinner || oldWinner === newWinner) {
    return { statements: [], summary: { updated_slots: 0, reset_matches: [] } };
  }
  const teamA = String(sourceMatch.team_a_id ?? "");
  const teamB = String(sourceMatch.team_b_id ?? "");
  if (![teamA, teamB].includes(oldWinner) || ![teamA, teamB].includes(newWinner)) {
    throw new Error("Победитель должен быть одной из команд исходного матча.");
  }
  const oldLoser = oldWinner === teamA ? teamB : teamA;
  const newLoser = newWinner === teamA ? teamB : teamA;

  const { results: matchRows } = await db.prepare(
    "SELECT id,bracket,round_number,status,team_a_id,team_b_id,score_a,score_b,winner_team_id,result_source,result_verified_at FROM matches WHERE tournament_id=?"
  ).bind(tournamentId).all();
  const matches = new Map((matchRows || []).map((row) => [String(row.id), { ...row }]));
  const sourceId = String(sourceMatch.id);
  if (!matches.has(sourceId)) throw new Error("Исходный матч не найден в сетке турнира.");

  let advancementRows = [];
  try {
    const result = await db.prepare(
      "SELECT match_id,outcome,next_match_id,next_slot FROM match_advancement"
    ).all();
    advancementRows = result.results || [];
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
  }
  let progressionRows = [];
  try {
    const result = await db.prepare(
      "SELECT match_id,next_match_id,next_slot FROM match_progression"
    ).all();
    progressionRows = result.results || [];
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
  }

  const routesByMatch = new Map();
  const addRoute = (matchId, route) => {
    const key = String(matchId);
    if (!routesByMatch.has(key)) routesByMatch.set(key, []);
    routesByMatch.get(key).push(route);
  };
  for (const route of advancementRows) {
    addRoute(route.match_id, route);
  }
  for (const route of progressionRows) {
    if (!(routesByMatch.get(String(route.match_id)) || []).length) {
      addRoute(route.match_id, { ...route, outcome: "winner" });
    }
  }

  const mutable = new Map();
  const resetIds = new Set();
  const queue = [];
  const processed = new Set();
  const changedSlots = new Map();
  const routeDestinations = new Set();
  const claimRouteDestination = (targetId, slot) => {
    const key = String(targetId) + ":" + slot;
    if (routeDestinations.has(key)) throw new Error("В сетке два маршрута ведут в один слот. Каскадная корректировка остановлена.");
    routeDestinations.add(key);
  };
  const current = (matchId) => {
    const key = String(matchId);
    if (!mutable.has(key)) {
      const original = matches.get(key);
      if (!original) return null;
      mutable.set(key, { ...original });
    }
    return mutable.get(key);
  };
  const markReset = (match) => {
    const key = String(match.id);
    resetIds.add(key);
    if (!processed.has(key) && !queue.includes(key)) queue.push(key);
  };
  const setSlot = (match, slot, value) => {
    if (slot !== "team_a_id" && slot !== "team_b_id") {
      throw new Error("В маршруте продвижения обнаружен некорректный слот.");
    }
    const row = current(match.id);
    if (!row) throw new Error("Связанный матч не найден. Каскадная корректировка остановлена.");
    if (!changedSlots.has(String(match.id))) changedSlots.set(String(match.id), new Set());
    if (String(row[slot] ?? "") === String(value ?? "")) return;
    row[slot] = value;
    changedSlots.get(String(match.id)).add(slot);
  };

  const directRoutes = routesByMatch.get(sourceId) || [];
  for (const route of directRoutes) {
    if (!["winner", "loser"].includes(route.outcome) ||
        !["team_a_id", "team_b_id"].includes(route.next_slot)) {
      throw new Error("В маршруте продвижения обнаружена некорректная конфигурация.");
    }
    const oldEntrant = route.outcome === "winner" ? oldWinner : oldLoser;
    const newEntrant = route.outcome === "winner" ? newWinner : newLoser;
    if (oldEntrant === newEntrant) continue;
    const target = matches.get(String(route.next_match_id));
    assertSupportedTarget(target);
    claimRouteDestination(target.id, route.next_slot);
    const slotValue = target[route.next_slot];
    if ((hasPlayedResult(target) && String(slotValue ?? "") !== oldEntrant) ||
        (slotValue != null && String(slotValue) !== oldEntrant)) {
      throw new Error("Слот связанного матча не совпадает с исходным участником. Каскадная корректировка остановлена.");
    }
    setSlot(target, route.next_slot, newEntrant);
    if (hasPlayedResult(target)) markReset(target);
  }

  while (queue.length) {
    const matchId = queue.shift();
    if (processed.has(matchId)) continue;
    processed.add(matchId);
    const invalidated = matches.get(matchId);
    const winner = invalidated.winner_team_id == null ? null : String(invalidated.winner_team_id);
    const loser = winner == null ? null : loserOf(invalidated);
    for (const route of routesByMatch.get(matchId) || []) {
      if (!["winner", "loser"].includes(route.outcome) ||
          !["team_a_id", "team_b_id"].includes(route.next_slot)) {
        throw new Error("В маршруте зависимого матча обнаружена некорректная конфигурация.");
      }
      const expectedEntrant = route.outcome === "winner" ? winner : loser;
      const target = matches.get(String(route.next_match_id));
      assertSupportedTarget(target);
      claimRouteDestination(target.id, route.next_slot);
      const slotValue = target[route.next_slot];
      if (expectedEntrant == null) {
        if (slotValue != null || hasPlayedResult(target)) {
          throw new Error("Незавершённый матч уже повлиял на сыгранную ветку. Каскадная корректировка остановлена.");
        }
      } else {
        if (hasPlayedResult(target) && slotValue == null) {
          throw new Error("У сыгранного зависимого матча отсутствует участник из предыдущего раунда. Каскадная корректировка остановлена.");
        }
        if (slotValue != null && String(slotValue) !== expectedEntrant) {
          throw new Error("У зависимого матча обнаружен участник, не совпадающий с историей продвижения. Каскадная корректировка остановлена.");
        }
        if (slotValue != null) setSlot(target, route.next_slot, null);
        if (hasPlayedResult(target)) markReset(target);
      }
    }
  }

  const statements = [];
  for (const [matchId, slots] of changedSlots) {
    const row = mutable.get(matchId);
    const original = matches.get(matchId);
    const shouldReset = resetIds.has(matchId);
    if (shouldReset) {
      statements.push(db.prepare(
        "UPDATE matches SET team_a_id=?,team_b_id=?,status='scheduled',score_a=NULL,score_b=NULL,winner_team_id=NULL,result_source=NULL,result_verified_at=NULL,updated_at=? WHERE id=? AND status=? AND team_a_id IS ? AND team_b_id IS ? AND score_a IS ? AND score_b IS ? AND winner_team_id IS ?"
      ).bind(row.team_a_id,row.team_b_id,timestamp,matchId,original.status,original.team_a_id,original.team_b_id,
        original.score_a,original.score_b,original.winner_team_id));
      statements.push(db.prepare(
        "INSERT INTO audit_events (action,entity_type,entity_id) SELECT NULL,'match','0' WHERE changes()=0"
      ));
      statements.push(db.prepare(
        "UPDATE result_events SET validation_status='reviewed',decision_reason=?,reviewed_at=? WHERE match_id=? AND validation_status='valid'"
      ).bind("Superseded by cascading result correction",timestamp,matchId));
    } else {
      const assignments = [...slots].map((slot) => slot + "=?");
      const values = [...slots].map((slot) => row[slot]);
      statements.push(db.prepare(
        "UPDATE matches SET " + assignments.join(",") + ",updated_at=? WHERE id=? AND status='scheduled' AND team_a_id IS ? AND team_b_id IS ? AND score_a IS ? AND score_b IS ? AND winner_team_id IS ?"
      ).bind(...values,timestamp,matchId,original.team_a_id,original.team_b_id,original.score_a,original.score_b,original.winner_team_id));
      statements.push(db.prepare(
        "INSERT INTO audit_events (action,entity_type,entity_id) SELECT NULL,'match','0' WHERE changes()=0"
      ));
    }
  }

  return {
    statements,
    summary: {
      route_count: directRoutes.length,
      route_outcomes: directRoutes.map((route) => route.outcome),
      updated_slots: [...changedSlots.values()].reduce((sum, slots) => sum + slots.size, 0),
      reset_matches: [...resetIds].map((id) => Number.isNaN(Number(id)) ? id : Number(id))
    }
  };
}
