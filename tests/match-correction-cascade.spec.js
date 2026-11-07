const { test, expect } = require("@playwright/test");
let prepareMatchCorrectionCascade;
test.beforeAll(async () => {
  ({ prepareMatchCorrectionCascade } = await import("../functions/api/v1/_lib/match-correction-cascade.mjs"));
});

function makeDb({ matches, advancement = [], progression = [] }) {
  const prepared = [];
  const db = {
    prepared,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() {
          if (sql.includes("FROM matches WHERE tournament_id")) return { results: matches };
          if (sql.includes("FROM match_advancement")) return { results: advancement };
          if (sql.includes("FROM match_progression")) return { results: progression };
          throw new Error("Unexpected all() SQL: " + sql);
        }
      };
      prepared.push(statement);
      return statement;
    }
  };
  return db;
}

const completed = (id, bracket, round, a, b, winner) => ({
  id, bracket, round_number: round, status: "completed",
  team_a_id: a, team_b_id: b, score_a: 2, score_b: 1, winner_team_id: winner,
  result_source: "admin_manual", result_verified_at: "2026-11-01T10:00:00.000Z"
});

test.describe("Safe downstream result correction cascade", () => {
  test("resets a played Single Elimination branch and clears its later result slots", async () => {
    const matches = [
      completed(1, "main", 1, 10, 11, 10),
      completed(2, "main", 2, 10, 12, 10),
      completed(3, "main", 3, 10, 13, 10)
    ];
    matches[0].tournament_format = "single_elimination";
    const db = makeDb({
      matches,
      progression: [
        { match_id: 1, next_match_id: 2, next_slot: "team_a_id" },
        { match_id: 2, next_match_id: 3, next_slot: "team_a_id" }
      ]
    });
    const result = await prepareMatchCorrectionCascade(db, 9, matches[0], 11, "2026-11-07T00:00:00.000Z");
    expect(result.summary).toEqual({ route_count: 1, route_outcomes: ["winner"], updated_slots: 2, reset_matches: [2, 3], cancelled_matches: [] });
    const resets = db.prepared.filter(statement => statement.sql.startsWith("UPDATE matches SET team_a_id=?,team_b_id=?"));
    expect(resets).toHaveLength(2);
    expect(resets[0].values.slice(0, 2)).toEqual(["11", 12]);
    expect(resets[0].values[3]).toBe("2");
    expect(resets[1].values.slice(0, 2)).toEqual([null, 13]);
    expect(resets[1].values[3]).toBe("3");
    expect(db.prepared.filter(statement => statement.sql.startsWith("UPDATE result_events"))).toHaveLength(2);
  });

  test("updates an unplayed scheduled next-round slot without resetting the match", async () => {
    const matches = [
      completed(1, "main", 1, 10, 11, 10),
      { id: 2, bracket: "main", round_number: 2, status: "scheduled", team_a_id: 10, team_b_id: 12, score_a: null, score_b: null, winner_team_id: null }
    ];
    matches[0].tournament_format = "single_elimination";
    const db = makeDb({
      matches,
      progression: [{ match_id: 1, next_match_id: 2, next_slot: "team_a_id" }]
    });
    const result = await prepareMatchCorrectionCascade(db, 9, matches[0], 11, "2026-11-07T00:00:00.000Z");
    expect(result.summary.reset_matches).toEqual([]);
    expect(result.summary.updated_slots).toBe(1);
    expect(db.prepared.filter(statement => statement.sql.startsWith("UPDATE result_events"))).toHaveLength(0);
    const update = db.prepared.find(statement => statement.sql.startsWith("UPDATE matches SET team_a_id=?"));
    expect(update.values[0]).toBe("11");
    expect(update.values[2]).toBe("2");
  });

  test("cascades both winner and loser routes across a Double Elimination branch", async () => {
    const matches = [
      completed(1, "upper", 1, 10, 11, 10),
      completed(2, "upper", 2, 10, 12, 10),
      completed(3, "lower", 1, 13, 11, 11),
      completed(4, "final", 1, 10, 11, 10),
      { id: 5, bracket: "lower", round_number: 2, status: "scheduled", team_a_id: 14, team_b_id: 12, score_a: null, score_b: null, winner_team_id: null }
    ];
    matches[0].tournament_format = "double_elimination";
    const db = makeDb({
      matches,
      advancement: [
        { match_id: 1, outcome: "winner", next_match_id: 2, next_slot: "team_a_id" },
        { match_id: 1, outcome: "loser", next_match_id: 3, next_slot: "team_b_id" },
        { match_id: 2, outcome: "winner", next_match_id: 4, next_slot: "team_a_id" },
        { match_id: 2, outcome: "loser", next_match_id: 5, next_slot: "team_b_id" },
        { match_id: 3, outcome: "winner", next_match_id: 4, next_slot: "team_b_id" }
      ]
    });
    const result = await prepareMatchCorrectionCascade(db, 9, matches[0], 11, "2026-11-07T00:00:00.000Z");
    expect(result.summary.reset_matches).toEqual([2, 3, 4]);
    expect(result.summary.updated_slots).toBe(5);
    const finalReset = db.prepared.find(statement =>
      statement.sql.startsWith("UPDATE matches SET team_a_id=?,team_b_id=?") && statement.values[3] === "4"
    );
    expect(finalReset.values.slice(0, 2)).toEqual([null, null]);
  });

  test("invalidates the Reset Final when a correction changes the lower finalist", async () => {
    const matches = [
      completed(1, "lower", 3, 10, 11, 10),
      completed(2, "final", 1, 20, 10, 10),
      completed(3, "final", 2, 20, 10, 10)
    ];
    matches[0].tournament_format = "double_elimination";
    const db = makeDb({
      matches,
      advancement: [{ match_id: 1, outcome: "winner", next_match_id: 2, next_slot: "team_b_id" }]
    });
    const result = await prepareMatchCorrectionCascade(db, 9, matches[0], 11, "2026-11-07T00:00:00.000Z");
    expect(result.summary.reset_matches).toEqual([2]);
    expect(result.summary.cancelled_matches).toEqual([3]);
    const grandFinal = db.prepared.find(statement =>
      statement.sql.startsWith("UPDATE matches SET team_a_id=?,team_b_id=?") && statement.values[3] === "2"
    );
    expect(grandFinal.values.slice(0, 2)).toEqual([20, "11"]);
    const resetFinal = db.prepared.find(statement =>
      statement.sql.startsWith("UPDATE matches SET team_a_id=NULL,team_b_id=NULL,status='cancelled'")
    );
    expect(resetFinal.values[1]).toBe("3");
    expect(db.prepared.filter(statement => statement.sql.startsWith("UPDATE result_events"))).toHaveLength(2);
  });

  test("blocks a branch whose next-match slot no longer matches the recorded source result", async () => {
    const matches = [
      completed(1, "main", 1, 10, 11, 10),
      { id: 2, bracket: "main", round_number: 2, status: "scheduled", team_a_id: 99, team_b_id: 12, score_a: null, score_b: null, winner_team_id: null }
    ];
    matches[0].tournament_format = "single_elimination";
    const db = makeDb({
      matches,
      progression: [{ match_id: 1, next_match_id: 2, next_slot: "team_a_id" }]
    });
    await expect(prepareMatchCorrectionCascade(db, 9, matches[0], 11, "2026-11-07T00:00:00.000Z"))
      .rejects.toThrow("Слот связанного матча не совпадает");
  });

  test("blocks an already-played descendant with a missing incoming participant", async () => {
    const matches = [
      completed(1, "main", 1, 10, 11, 10),
      completed(2, "main", 2, null, 12, 12)
    ];
    matches[0].tournament_format = "single_elimination";
    const db = makeDb({
      matches,
      progression: [{ match_id: 1, next_match_id: 2, next_slot: "team_a_id" }]
    });
    await expect(prepareMatchCorrectionCascade(db, 9, matches[0], 11, "2026-11-07T00:00:00.000Z"))
      .rejects.toThrow("Слот связанного матча не совпадает");
  });
});
