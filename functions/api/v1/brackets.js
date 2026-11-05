import { json, databaseUnavailable, methodNotAllowed } from "./_lib/http.js";
import { getSessionUser, sameOrigin } from "./_lib/session-auth.js";

async function createMatch(db, tournamentId, bracket, round, number, teamA, teamB, status, now) {
  const result = await db.prepare(
    "INSERT INTO matches (tournament_id,round_number,bracket,match_number,status,team_a_id,team_b_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(tournamentId, round, bracket, number, status, teamA ?? null, teamB ?? null, now, now).run();
  const id = Number(result.meta?.last_row_id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Match ID was not returned");
  return { id, bracket, round, number };
}

async function createDoubleElimination(db, tournamentId, teams, now, created) {
  const size = teams.length;
  const upperRoundCount = Math.log2(size);
  const upper = [];
  const lower = [];
  for (let round = 1; round <= upperRoundCount; round++) {
    const count = size / (2 ** round);
    const rows = [];
    for (let index = 0; index < count; index++) {
      const a = round === 1 ? teams[index * 2].id : null;
      const b = round === 1 ? teams[index * 2 + 1].id : null;
      const match = await createMatch(db, tournamentId, "upper", round, index + 1, a, b, "scheduled", now);
      rows.push(match); created.push(match.id);
    }
    upper.push(rows);
  }

  for (let round = 1; round <= 2 * (upperRoundCount - 1); round++) {
    const count = size / (2 ** (Math.floor((round + 1) / 2) + 1));
    const rows = [];
    for (let index = 0; index < count; index++) {
      const match = await createMatch(db, tournamentId, "lower", round, index + 1, null, null, "scheduled", now);
      rows.push(match); created.push(match.id);
    }
    lower.push(rows);
  }

  const grandFinal = await createMatch(db, tournamentId, "final", 1, 1, null, null, "scheduled", now);
  created.push(grandFinal.id);
  const resetFinal = await createMatch(db, tournamentId, "final", 2, 1, null, null, "cancelled", now);
  created.push(resetFinal.id);

  const routes = [];
  const route = (source, outcome, target, slot) => {
    routes.push(db.prepare(
      "INSERT INTO match_advancement (match_id,outcome,next_match_id,next_slot) VALUES (?,?,?,?)"
    ).bind(source.id, outcome, target.id, slot));
  };

  upper.forEach((roundRows, roundIndex) => {
    const roundNumber = roundIndex + 1;
    roundRows.forEach((match, index) => {
      if (roundIndex < upper.length - 1) {
        const next = upper[roundIndex + 1][Math.floor(index / 2)];
        route(match, "winner", next, index % 2 === 0 ? "team_a_id" : "team_b_id");
      } else {
        route(match, "winner", grandFinal, "team_a_id");
      }

      if (roundNumber === 1 && lower.length) {
        const target = lower[0][Math.floor(index / 2)];
        route(match, "loser", target, index % 2 === 0 ? "team_a_id" : "team_b_id");
      } else if (roundIndex > 0 && roundIndex < upper.length - 1) {
        const targetRound = lower[(2 * roundNumber) - 3];
        route(match, "loser", targetRound[index], "team_b_id");
      } else if (roundIndex === upper.length - 1) {
        if (lower.length) route(match, "loser", lower[lower.length - 1][0], "team_b_id");
        else route(match, "loser", grandFinal, "team_b_id");
      }
    });
  });

  lower.forEach((roundRows, roundIndex) => {
    roundRows.forEach((match, index) => {
      if (roundIndex === lower.length - 1) {
        route(match, "winner", grandFinal, "team_b_id");
      } else if ((roundIndex + 1) % 2 === 1) {
        route(match, "winner", lower[roundIndex + 1][index], "team_a_id");
      } else {
        route(match, "winner", lower[roundIndex + 1][Math.floor(index / 2)], "team_a_id");
      }
    });
  });

  for (let offset = 0; offset < routes.length; offset += 50) {
    await db.batch(routes.slice(offset, offset + 50));
  }
  return { matches: created.length, upper_rounds: upper.length, lower_rounds: lower.length, grand_final_id: grandFinal.id, reset_final_id: resetFinal.id };
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED", message: "Запрос отклонён." } }, 403);
  const auth = await getSessionUser(request, env);
  if (auth.error) return auth.error;
  if (!auth.user) return json({ error: { code: "UNAUTHORIZED", message: "Войди в аккаунт организатора." } }, 401);
  if (!auth.user.roles.includes("administrator") && !auth.user.roles.includes("organizer")) return json({ error: { code: "FORBIDDEN", message: "Создавать сетку может только организатор." } }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Некорректный запрос." } }, 400); }
  const tournamentId = String(body.tournament_id || "").trim();
  if (!tournamentId) return json({ error: { code: "INVALID_TOURNAMENT", message: "Укажи турнир." } }, 400);
  const tournament = await env.DB.prepare("SELECT id,title,format,status,organizer_id FROM tournaments WHERE id=?").bind(tournamentId).first();
  if (!tournament) return json({ error: { code: "TOURNAMENT_NOT_FOUND", message: "Турнир не найден." } }, 404);
  if (!auth.user.roles.includes("administrator") && String(tournament.organizer_id) !== String(auth.user.id)) return json({ error: { code: "FORBIDDEN", message: "У тебя нет доступа к этому турниру." } }, 403);
  if (!["published","active"].includes(tournament.status)) return json({ error: { code: "TOURNAMENT_NOT_OPEN", message: "Сначала опубликуй турнир." } }, 409);
  const existing = await env.DB.prepare("SELECT COUNT(*) AS total FROM matches WHERE tournament_id=?").bind(tournamentId).first();
  if ((existing?.total || 0) > 0) return json({ error: { code: "BRACKET_EXISTS", message: "Сетка уже создана. Удалять существующие матчи автоматически небезопасно." } }, 409);
  const { results: registrations } = await env.DB.prepare("SELECT tm.id,tm.name,tm.tag FROM tournament_registrations r JOIN teams tm ON tm.id=r.team_id WHERE r.tournament_id=? AND r.status='approved' AND tm.status='active' ORDER BY r.submitted_at ASC,tm.id ASC").bind(tournamentId).all();
  const teams = registrations || [];
  if (teams.length < 2) return json({ error: { code: "NOT_ENOUGH_TEAMS", message: "Для сетки нужны минимум две одобренные команды." } }, 409);
  if (teams.length > 32) return json({ error: { code: "BRACKET_TEAM_LIMIT", message: "Автогенерация сетки поддерживает максимум 32 команды." } }, 409);
  const now = new Date().toISOString();
  const created = [];
  try {
    if (tournament.format === "round_robin") {
      let matchNo = 1;
      const statements = [];
      for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
        statements.push(env.DB.prepare("INSERT INTO matches (tournament_id,round_number,bracket,match_number,status,team_a_id,team_b_id,created_at,updated_at) VALUES (?,1,'group',?,'scheduled',?,?,?,?)").bind(tournamentId, matchNo++, teams[i].id, teams[j].id, now, now));
      }
      for (let offset = 0; offset < statements.length; offset += 50) {
        const inserted = await env.DB.batch(statements.slice(offset, offset + 50));
        for (const row of inserted) {
          const id = Number(row.meta?.last_row_id);
          if (!Number.isSafeInteger(id) || id < 1) throw new Error("Round Robin match ID was not returned");
          created.push(id);
        }
      }
    } else if (tournament.format === "single_elimination") {
      const size = 2 ** Math.ceil(Math.log2(teams.length));
      if (size > 32 || size !== teams.length) return json({ error: { code: "BRACKET_TEAM_COUNT", message: "Для сетки Single Elimination сейчас нужно 2, 4, 8, 16 или 32 команды. Добавь команды или выбери Round Robin." } }, 409);
      const rounds = Math.log2(size);
      const roundMatches = [];
      for (let round = 1; round <= rounds; round++) {
        const count = size / (2 ** round), ids = [];
        for (let index = 0; index < count; index++) {
          const a = round === 1 ? teams[index * 2].id : null;
          const b = round === 1 ? teams[index * 2 + 1].id : null;
          const row = await env.DB.prepare("INSERT INTO matches (tournament_id,round_number,bracket,match_number,status,team_a_id,team_b_id,created_at,updated_at) VALUES (?,?,'main',?,'scheduled',?,?,?,?)").bind(tournamentId, round, index + 1, a, b, now, now).run();
          const id = Number(row.meta?.last_row_id);
          if (!Number.isSafeInteger(id) || id < 1) throw new Error("Match ID was not returned");
          ids.push(id); created.push(id);
        }
        roundMatches.push(ids);
      }
      for (let round = 0; round < roundMatches.length - 1; round++) {
        for (let index = 0; index < roundMatches[round].length; index++) {
          const nextId = roundMatches[round + 1][Math.floor(index / 2)];
          const slot = index % 2 === 0 ? "team_a_id" : "team_b_id";
          await env.DB.prepare("INSERT INTO match_progression (match_id,next_match_id,next_slot) VALUES (?,?,?)").bind(roundMatches[round][index], nextId, slot).run();
        }
      }
    } else if (tournament.format === "double_elimination") {
      const size = teams.length;
      if ((size & (size - 1)) !== 0) return json({ error: { code: "BRACKET_TEAM_COUNT", message: "Для Double Elimination нужно 2, 4, 8, 16 или 32 команды. Сначала утверди состав кратный степени двойки." } }, 409);
      const details = await createDoubleElimination(env.DB, tournamentId, teams, now, created);
      await env.DB.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_json) VALUES (?,'bracket_generated','tournament',?,?)").bind(auth.user.id, tournamentId, JSON.stringify({ format: tournament.format, teams: teams.length, matches: created.length, double_elimination: details })).run();
      return json({ data: { tournament_id: tournamentId, format: tournament.format, teams: teams.length, matches_created: created.length, match_ids: created, ...details } }, 201);
    } else {
      return json({ error: { code: "FORMAT_NOT_SUPPORTED", message: "Автогенерация сетки пока доступна для Single Elimination, Double Elimination и Round Robin." } }, 422);
    }
    await env.DB.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_json) VALUES (?,'bracket_generated','tournament',?,?)").bind(auth.user.id, tournamentId, JSON.stringify({ format: tournament.format, teams: teams.length, matches: created.length })).run();
    return json({ data: { tournament_id: tournamentId, format: tournament.format, teams: teams.length, matches_created: created.length, match_ids: created } }, 201);
  } catch (error) {
    console.error("Bracket generation failed:", error);
    for (let offset = 0; offset < created.length; offset += 50) {
      const chunk = created.slice(offset, offset + 50);
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare("DELETE FROM matches WHERE tournament_id=? AND id IN (" + placeholders + ")")
        .bind(tournamentId, ...chunk).run().catch((cleanupError) => {
          console.error("Bracket rollback cleanup failed:", cleanupError);
        });
    }
    return json({ error: { code: "BRACKET_GENERATION_FAILED", message: "Не удалось создать сетку. Частично созданные матчи удалены. Проверь состав участников и повтори попытку." } }, 500);
  }
}
export function onRequestGet() { return methodNotAllowed("POST"); }
