const { test, expect } = require("@playwright/test");
let seeding;

test.beforeAll(async () => {
  seeding = await import("../functions/api/v1/_lib/single-elimination-seeding.mjs");
});

test.describe("Single Elimination bracket seeding", () => {
  test("supports a 10-team tournament with six byes and two opening matches", () => {
    const teams = Array.from({ length: 10 }, (_, index) => index + 1);
    const result = seeding.buildSingleEliminationSeeding(teams);
    expect(result.size).toBe(16);
    expect(result.firstRoundPairs.filter((pair) => pair.bye_team_id == null)).toHaveLength(2);
    expect(result.firstRoundPairs.filter((pair) => pair.bye_team_id != null)).toHaveLength(6);
    expect(result.firstRoundSlots.filter((id) => id != null).sort((a, b) => a - b)).toEqual(teams);
  });

  test("places every team exactly once and never creates an empty first-round pairing", () => {
    for (let count = 2; count <= 32; count++) {
      const teams = Array.from({ length: count }, (_, index) => index + 1);
      const result = seeding.buildSingleEliminationSeeding(teams);
      const placed = result.firstRoundSlots.filter((id) => id != null).sort((a, b) => a - b);
      expect(placed, "team count " + count).toEqual(teams);
      expect(result.firstRoundPairs.every((pair) => pair.team_a_id != null || pair.team_b_id != null), "team count " + count).toBeTruthy();
      expect(result.firstRoundPairs.filter((pair) => pair.bye_team_id == null).length, "team count " + count).toBe(count - result.size / 2);
    }
  });

  test("rejects fewer than two teams and more than 32 teams", () => {
    expect(() => seeding.buildSingleEliminationSeeding([1])).toThrow();
    expect(() => seeding.buildSingleEliminationSeeding(Array.from({ length: 33 }, (_, index) => index + 1))).toThrow();
  });
});
