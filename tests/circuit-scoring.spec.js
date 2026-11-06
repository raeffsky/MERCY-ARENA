const { test } = require("@playwright/test");
const { expect } = require("@playwright/test");
let scoring;
test.beforeAll(async () => { scoring = await import("../functions/api/v1/_lib/circuit-scoring.js"); });

test.describe("MERCY CIRCUIT placement scoring", () => {
  test("applies the fixed placement bands", () => {
    expect([1,2,3,4,5,8,9,16,17,32].map(scoring.defaultPlacementPoints)).toEqual([100,75,55,55,25,25,10,10,5,5]);
  });
  test("maps places to stable placement groups", () => {
    expect([1,2,3,5,9,17].map(scoring.placementGroup)).toEqual(["1","2","3-4","5-8","9-16","participation"]);
  });
  test("season rules override defaults without changing the placement band", () => {
    expect(scoring.pointsForPlacement(3,[{place_from:3,place_to:4,points:60}])).toBe(60);
    expect(scoring.pointsForPlacement(1,[])).toBe(100);
  });
  test("ranking tie-breaks are deterministic and team-based", () => {
    const ranked = scoring.buildCircuitRanking([
      {team_id:3,team_name:"C",points:100,first_places:1},
      {team_id:2,team_name:"B",points:100,first_places:2},
      {team_id:1,team_name:"A",points:90,first_places:0}
    ]);
    expect(ranked.map(row=>row.team_id)).toEqual([2,3,1]);
    expect(ranked.map(row=>row.rank)).toEqual([1,2,3]);
  });
});
