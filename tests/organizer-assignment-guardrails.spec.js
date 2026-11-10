const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('tournament organizer assignment is validated against the organizer role on the server', () => {
  const admin = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/admin.js'), 'utf8');
  expect(admin).toContain('Object.prototype.hasOwnProperty.call(data, "organizer_id")');
  expect(admin).toContain("SELECT user_id FROM user_roles WHERE user_id=? AND role='organizer' LIMIT 1");
  expect(admin).toContain('Назначить турнир можно только пользователю с активной ролью организатора.');
});

test('organizer role changes require an explicit boolean and owner authorization', () => {
  const admin = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/admin.js'), 'utf8');
  expect(admin).toContain('const auth = await authorize(request, env)');
  expect(admin).toContain('typeof enabled !== "boolean"');
  expect(admin).toContain('action === "set_organizer"');
});
