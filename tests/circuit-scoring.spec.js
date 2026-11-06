const { test } = require("@playwright/test");
const { expect } = require("@playwright/test");
let scoring;
test.beforeAll(async () => { scoring = await import("../functions/api/v1/_lib/circuit-scoring.mjs"); });

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
  test("derives Single Elimination placements from completed rounds", () => {
    const matches = [
      {bracket:"main",round_number:1,status:"completed",team_a_id:1,team_b_id:2,winner_team_id:1},
      {bracket:"main",round_number:1,status:"completed",team_a_id:3,team_b_id:4,winner_team_id:3},
      {bracket:"main",round_number:2,status:"completed",team_a_id:1,team_b_id:3,winner_team_id:1}
    ];
    expect(scoring.deriveTournamentPlacements("single_elimination",matches)).toEqual([
      {team_id:"1",placement:1},{team_id:"3",placement:2},{team_id:"2",placement:3},{team_id:"4",placement:3}
    ]);
  });
  test("derives Double Elimination placements including lower-bracket exits", () => {
    const matches = [
      {bracket:"upper",round_number:1,status:"completed",team_a_id:1,team_b_id:2,winner_team_id:1},
      {bracket:"upper",round_number:1,status:"completed",team_a_id:3,team_b_id:4,winner_team_id:3},
      {bracket:"upper",round_number:2,status:"completed",team_a_id:1,team_b_id:3,winner_team_id:1},
      {bracket:"lower",round_number:1,status:"completed",team_a_id:2,team_b_id:4,winner_team_id:2},
      {bracket:"lower",round_number:2,status:"completed",team_a_id:2,team_b_id:3,winner_team_id:2},
      {bracket:"final",round_number:1,status:"completed",team_a_id:1,team_b_id:2,winner_team_id:1},
      {bracket:"final",round_number:2,status:"cancelled",team_a_id:1,team_b_id:2,winner_team_id:null}
    ];
    expect(scoring.deriveTournamentPlacements("double_elimination",matches)).toEqual([
      {team_id:"1",placement:1},{team_id:"2",placement:2},{team_id:"3",placement:3},{team_id:"4",placement:4}
    ]);
  });
  test("derives Round Robin placements from wins and score difference", () => {
    const matches = [
      {bracket:"group",status:"completed",team_a_id:1,team_b_id:2,score_a:2,score_b:0,winner_team_id:1},
      {bracket:"group",status:"completed",team_a_id:1,team_b_id:3,score_a:2,score_b:1,winner_team_id:1},
      {bracket:"group",status:"completed",team_a_id:2,team_b_id:3,score_a:2,score_b:0,winner_team_id:2}
    ];
    expect(scoring.deriveTournamentPlacements("round_robin",matches)).toEqual([
      {team_id:"1",placement:1},{team_id:"2",placement:2},{team_id:"3",placement:3}
    ]);
  });
  test("derives complete Double Elimination placement groups for 4, 8, 16 and 32 teams", () => {
    for (const size of [4,8,16,32]) {
      const rounds = [];
      const upperRoundCount = Math.log2(size);
      for (let round = 1; round <= 2 * (upperRoundCount - 1); round++) {
        const count = size / (2 ** (Math.floor((round + 1) / 2) + 1));
        const rows = [];
        for (let index = 0; index < count; index++) {
          const eliminatedTeam = 3 + rounds.reduce((sum, group) => sum + group.length, 0) + index;
          rows.push({bracket:"lower",round_number:round,status:"completed",team_a_id:eliminatedTeam,team_b_id:1,winner_team_id:1});
        }
        rounds.push(rows);
      }
      const lowerMatches = rounds.flat();
      const final = {bracket:"final",round_number:1,status:"completed",team_a_id:1,team_b_id:2,winner_team_id:1};
      const placements = scoring.deriveTournamentPlacements("double_elimination",[...lowerMatches,final]);
      expect(placements).toHaveLength(size);
      expect(new Set(placements.map(row=>row.team_id)).size).toBe(size);
      expect(placements.find(row=>row.team_id==="1").placement).toBe(1);
      expect(placements.find(row=>row.team_id==="2").placement).toBe(2);
      expect(placements.filter(row=>row.placement===3)).toHaveLength(1);
    }
  });

  test("Double Elimination reset final decides the champion when the lower finalist wins game one", () => {
    const matches = [
      {bracket:"upper",round_number:1,status:"completed",team_a_id:1,team_b_id:2,winner_team_id:1},
      {bracket:"upper",round_number:1,status:"completed",team_a_id:3,team_b_id:4,winner_team_id:3},
      {bracket:"upper",round_number:2,status:"completed",team_a_id:1,team_b_id:3,winner_team_id:1},
      {bracket:"lower",round_number:1,status:"completed",team_a_id:2,team_b_id:4,winner_team_id:2},
      {bracket:"lower",round_number:2,status:"completed",team_a_id:2,team_b_id:3,winner_team_id:2},
      {bracket:"final",round_number:1,status:"completed",team_a_id:1,team_b_id:2,winner_team_id:2},
      {bracket:"final",round_number:2,status:"completed",team_a_id:1,team_b_id:2,winner_team_id:2}
    ];
    expect(scoring.deriveTournamentPlacements("double_elimination",matches).slice(0,2)).toEqual([
      {team_id:"2",placement:1},{team_id:"1",placement:2}
    ]);
  });

});
