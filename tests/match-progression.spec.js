const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let advanceWinner;
test.beforeAll(async () => {
  const helperPath = path.join(process.cwd(), "functions/api/v1/_lib/match-progression.js");
  const scoringUrl = pathToFileURL(path.join(process.cwd(), "functions/api/v1/_lib/circuit-scoring.mjs")).href;
  const source = fs.readFileSync(helperPath, "utf8")
    .replace('from "./circuit-scoring.mjs";', 'from "' + scoringUrl + '";')
    .replace('import { createAuditEventId } from "./audit.js";', 'const createAuditEventId = async () => "test-audit-event";');
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
  ({ advanceWinner } = await import(moduleUrl));
});

function fakeDb({ match, routes = [], reset = null, batchChanges = null }) {
  const statements = [];
  const db = {
    statements,
    batchCalls: [],
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("FROM matches WHERE id=? LIMIT 1")) return match;
          if (sql.includes("FROM match_progression")) return null;
          if (sql.includes("FROM matches WHERE tournament_id=? AND bracket='final'")) return reset;
          if (sql.startsWith("SELECT COUNT(*) AS total")) return { total: 0, completed: 0 };
          throw new Error("Unexpected first() SQL: " + sql);
        },
        async all() {
          if (sql.includes("FROM match_advancement")) return { results: routes };
          throw new Error("Unexpected all() SQL: " + sql);
        },
        async run() {
          statements.push(this);
          return { meta: { changes: 1 } };
        }
      };
      statements.push(statement);
      return statement;
    },
    async batch(batchStatements) {
      this.batchCalls.push(batchStatements);
      return batchStatements.map((_, index) => ({ meta: { changes: batchChanges?.[index] ?? 1 } }));
    }
  };
  return db;
}

test.describe("MERCY ARENA match progression lifecycle", () => {
  test("routes the winner and loser into their independent Double Elimination slots", async () => {
    const db = fakeDb({
      match: { id: 1, tournament_id: 9, bracket: "upper", round_number: 1, team_a_id: 10, team_b_id: 11 },
      routes: [
        { outcome: "winner", next_match_id: 2, next_slot: "team_a_id" },
        { outcome: "loser", next_match_id: 3, next_slot: "team_b_id" }
      ]
    });
    const result = await advanceWinner(db, 1, 10);
    expect(result.advanced).toBeTruthy();
    expect(db.batchCalls).toHaveLength(1);
    const updates = db.batchCalls[0];
    expect(updates[0].sql).toContain("UPDATE matches SET team_a_id=?");
    expect(updates[0].values[0]).toBe(10);
    expect(updates[0].values[2]).toBe(2);
    expect(updates[1].sql).toContain("UPDATE matches SET team_b_id=?");
    expect(updates[1].values[0]).toBe(11);
    expect(updates[1].values[2]).toBe(3);
  });

  test("rejects a winner who did not participate in the match", async () => {
    const db = fakeDb({
      match: { id: 1, tournament_id: 9, bracket: "upper", round_number: 1, team_a_id: 10, team_b_id: 11 }
    });
    await expect(advanceWinner(db, 1, 99)).rejects.toThrow("Winner is not a participant");
    expect(db.batchCalls).toHaveLength(0);
  });

  test("does not overwrite a progression slot already claimed by another result", async () => {
    const db = fakeDb({
      match: { id: 1, tournament_id: 9, bracket: "upper", round_number: 1, team_a_id: 10, team_b_id: 11 },
      routes: [{ outcome: "winner", next_match_id: 2, next_slot: "team_a_id" }],
      batchChanges: [0]
    });
    await expect(advanceWinner(db, 1, 10)).rejects.toThrow("Bracket slot was changed by another result");
  });

  test("activates the Double Elimination reset final when the lower finalist wins game one", async () => {
    const db = fakeDb({
      match: { id: 7, tournament_id: 9, bracket: "final", round_number: 1, team_a_id: 10, team_b_id: 11 },
      reset: { id: 8, status: "cancelled" }
    });
    const result = await advanceWinner(db, 7, 11);
    expect(result).toEqual({ advanced: false, final_reset: true, next_match_id: 8 });
    const resetUpdate = db.statements.find(statement => statement.sql.includes("status='scheduled'"));
    expect(resetUpdate.values[0]).toBe(10);
    expect(resetUpdate.values[1]).toBe(11);
    expect(resetUpdate.values[3]).toBe(8);
  });
});
