const { test, expect } = require("@playwright/test");
let prepareFinalizedCircuitCorrection;
test.beforeAll(async () => {
  ({ prepareFinalizedCircuitCorrection } = await import("../functions/api/v1/_lib/match-progression.js"));
});

function singleEliminationFixture(overrides = {}) {
  const state = {
    tournament: { id: 7, format: "single_elimination", season_id: 3, status: "completed" },
    qualifier: null,
    lockedEntries: 0,
    matches: [
      { id: 501, bracket: "main", round_number: 1, status: "completed", team_a_id: 1, team_b_id: 2, score_a: 2, score_b: 1, winner_team_id: 1 }
    ],
    registrations: [{ team_id: 1 }, { team_id: 2 }],
    existing: [
      { id: 11, team_id: 1, placement: 1, placement_group: "1", points_awarded: 100, is_qualifier: 0 },
      { id: 12, team_id: 2, placement: 2, placement_group: "2", points_awarded: 75, is_qualifier: 0 }
    ],
    ledger: [{ result_id: 11, balance: 100 }, { result_id: 12, balance: 75 }],
    rules: []
  };
  Object.assign(state, overrides);
  return createFakeDb(state);
}

function roundRobinFixture() {
  const matches = [
    { id: 601, bracket: "group", round_number: 1, status: "completed", team_a_id: 1, team_b_id: 2, score_a: 2, score_b: 0, winner_team_id: 1 },
    { id: 602, bracket: "group", round_number: 1, status: "completed", team_a_id: 1, team_b_id: 3, score_a: 2, score_b: 0, winner_team_id: 1 },
    { id: 603, bracket: "group", round_number: 1, status: "completed", team_a_id: 1, team_b_id: 4, score_a: 2, score_b: 0, winner_team_id: 1 },
    { id: 604, bracket: "group", round_number: 1, status: "completed", team_a_id: 2, team_b_id: 3, score_a: 1, score_b: 0, winner_team_id: 2 },
    { id: 605, bracket: "group", round_number: 1, status: "completed", team_a_id: 3, team_b_id: 4, score_a: 1, score_b: 0, winner_team_id: 3 },
    { id: 606, bracket: "group", round_number: 1, status: "completed", team_a_id: 4, team_b_id: 2, score_a: 1, score_b: 0, winner_team_id: 4 }
  ];
  return createFakeDb({
    tournament: { id: 8, format: "round_robin", season_id: 3, status: "completed" },
    qualifier: null,
    lockedEntries: 0,
    matches,
    registrations: [1,2,3,4].map(team_id => ({ team_id })),
    existing: [
      { id: 21, team_id: 1, placement: 1, placement_group: "1", points_awarded: 55, is_qualifier: 0 },
      { id: 22, team_id: 2, placement: 2, placement_group: "2", points_awarded: 55, is_qualifier: 0 },
      { id: 23, team_id: 3, placement: 3, placement_group: "3-4", points_awarded: 55, is_qualifier: 0 },
      { id: 24, team_id: 4, placement: 4, placement_group: "3-4", points_awarded: 55, is_qualifier: 0 }
    ],
    ledger: [21,22,23,24].map((id) => ({ result_id: id, balance: 55 })),
    rules: [{ place_from: 1, place_to: 4, points: 55 }]
  });
}

function createFakeDb(state) {
  const prepared = [];
  const db = {
    prepared,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("FROM tournaments")) return state.tournament;
          if (sql.includes("FROM circuit_qualifiers")) return state.qualifier;
          if (sql.includes("FROM circuit_championship_entries")) return { total: state.lockedEntries };
          throw new Error("Unexpected first() SQL: " + sql);
        },
        async all() {
          if (sql.startsWith("PRAGMA table_info(audit_events)")) return { results: [{ name: "id", type: "TEXT" }] };
          if (sql.includes("FROM matches WHERE tournament_id")) return { results: state.matches };
          if (sql.includes("FROM tournament_registrations")) return { results: state.registrations };
          if (sql.includes("FROM circuit_tournament_results")) return { results: state.existing };
          if (sql.includes("FROM circuit_point_transactions")) return { results: state.ledger };
          if (sql.includes("FROM circuit_scoring_rules")) return { results: state.rules };
          throw new Error("Unexpected all() SQL: " + sql);
        }
      };
      prepared.push(statement);
      return statement;
    }
  };
  return db;
}

function transactionStatements(db) {
  return db.prepared.filter((statement) =>
    statement.sql.includes("INSERT INTO circuit_point_transactions")
  );
}

test.describe("MERCY CIRCUIT finalized result reconciliation", () => {
  test("appends a positive correction when a team gains placement points", async () => {
    const db = singleEliminationFixture();
    const result = await prepareFinalizedCircuitCorrection(db, 7, 99, 501, {
      score_a: 1, score_b: 2, winner_team_id: 2
    });
    expect(result.summary.changes).toEqual([
      { team_id: 1, from_placement: 1, to_placement: 2, points_delta: -25 },
      { team_id: 2, from_placement: 2, to_placement: 1, points_delta: 25 }
    ]);
    expect(transactionStatements(db).map(row => row.values[4])).toEqual([-25, 25]);
    expect(transactionStatements(db).every(row => row.sql.includes("'correction'"))).toBeTruthy();
  });

  test("appends a negative correction without rewriting historical ledger rows", async () => {
    const db = singleEliminationFixture();
    const result = await prepareFinalizedCircuitCorrection(db, 7, 99, 501, {
      score_a: 1, score_b: 2, winner_team_id: 2
    });
    const writes = transactionStatements(db);
    expect(writes).toHaveLength(2);
    expect(writes.map(row => row.values[4])).toContain(-25);
    expect(writes.every(row => !/UPDATE|DELETE/i.test(row.sql))).toBeTruthy();
    expect(result.summary.points_delta).toBe(0);
  });

  test("updates placements without creating ledger transactions when the scoring band is unchanged", async () => {
    const db = roundRobinFixture();
    const result = await prepareFinalizedCircuitCorrection(db, 8, 99, 601, {
      score_a: 100, score_b: 0, winner_team_id: 1
    });
    expect(result.summary.changes.some(row => row.team_id === 2 && row.from_placement === 2 && row.to_placement === 4)).toBeTruthy();
    expect(transactionStatements(db)).toHaveLength(0);
    expect(db.prepared.some(row => row.sql.includes("UPDATE circuit_tournament_results SET placement="))).toBeTruthy();
  });

  test("blocks reconciliation when the append-only ledger balance does not match the result row", async () => {
    const db = singleEliminationFixture({
      ledger: [{ result_id: 11, balance: 99 }, { result_id: 12, balance: 75 }]
    });
    await expect(prepareFinalizedCircuitCorrection(db, 7, 99, 501, {
      score_a: 1, score_b: 2, winner_team_id: 2
    })).rejects.toThrow("Баланс журнала Circuit не совпадает");
  });

  test("blocks reconciliation when approved registrations and derived placements differ", async () => {
    const db = singleEliminationFixture({
      registrations: [{ team_id: 1 }, { team_id: 2 }, { team_id: 3 }]
    });
    await expect(prepareFinalizedCircuitCorrection(db, 7, 99, 501, {
      score_a: 1, score_b: 2, winner_team_id: 2
    })).rejects.toThrow("не совпадают с утверждёнными командами");
  });

  test("blocks reconciliation when championship entries are already locked", async () => {
    const db = singleEliminationFixture({ lockedEntries: 8 });
    await expect(prepareFinalizedCircuitCorrection(db, 7, 99, 501, {
      score_a: 1, score_b: 2, winner_team_id: 2
    })).rejects.toThrow("уже зафиксирован");
  });

  test("keeps qualifier corrections outside the general tournament correction flow", async () => {
    const db = singleEliminationFixture({ qualifier: { id: 4, awards_points: 0 } });
    await expect(prepareFinalizedCircuitCorrection(db, 7, 99, 501, {
      score_a: 1, score_b: 2, winner_team_id: 2
    })).rejects.toThrow("квалификационный турнир");
  });
});
