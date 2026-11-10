const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('generic admin editor cannot bypass team roster invariants by editing players.team_id directly', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/admin.js'), 'utf8');
  const page = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  expect(api).toContain('players: { table: "players", fields: ["user_id","game_id","nickname","role","region","profile_status"] }');
  expect(page).not.toContain("['team_id','ID команды','number']");
  expect(page).toContain("players:[['user_id','Аккаунт пользователя'");
  expect(api).toContain('teams: { table: "teams", fields: ["name","tag","logo_url","region","status"] }');
  expect(page).not.toContain("['captain_id','Аккаунт капитана'");
});
