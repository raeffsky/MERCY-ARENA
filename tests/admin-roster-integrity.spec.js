const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('generic admin editor cannot bypass team roster invariants by editing players.team_id directly', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/admin.js'), 'utf8');
  const page = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  expect(page).not.toContain("['team_id','ID команды','number']");
  expect(api).toContain('teams: { table: "teams", fields: ["name","tag","logo_url","region","status"] }');
  expect(api).toContain('players: { table: "players", fields: ["game_id","nickname","role","region","profile_status"] }');
  expect(page).not.toContain("['user_id','Аккаунт пользователя','select'");
  expect(page).not.toContain("['captain_id','Аккаунт капитана'");
});
