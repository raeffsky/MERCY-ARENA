const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test('only the platform owner can cancel an unresolved scheduled MERCY CROWN defense', () => {
  const api = source('functions/api/v1/crown.js');
  expect(api).toContain('action === "cancel_challenge"');
  const cancelBlock = api.slice(api.indexOf('action === "cancel_challenge"'), api.indexOf('action === "resolve_challenge"'));
  expect(cancelBlock).toContain('/^\\d+$/');
  expect(api).toContain("status='cancelled',decided_at=? WHERE id=? AND status='scheduled'");
  expect(api).toContain("m.status!='completed'");
  expect(api).toContain('CROWN_MATCH_COMPLETED');
  expect(api).toContain("'mercy_crown_challenge_cancelled'");
  expect(api).toContain('CHALLENGE_NOT_OPEN');
});

test('CROWN control panel offers a guarded cancellation action for pending defenses', () => {
  const page = source('index.html');
  expect(page).toContain('id="crownCancelForm"');
  expect(page).toContain('Отменить защиту');
  expect(page).toContain("action:'cancel_challenge'");
  expect(page).toContain('Отменить назначенную защиту MERCY CROWN?');
});
