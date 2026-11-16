const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('notification feed is scoped to the session and marked private no-store', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/notifications.js'), 'utf8');
  expect(api).toContain('WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?');
  expect(api).toContain('WHERE user_id=? AND read_at IS NULL');
  expect(api).toContain('"Cache-Control": "no-store, private"');
});

test('notification mutation can only update the current account notifications', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/notifications.js'), 'utf8');
  expect(api).toContain('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL');
  expect(api).toContain('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?');
});

test('full notification inbox keeps existing loader, syncs badge and validates notification destinations', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  expect(page).toContain("if(key==='notifications'){");
  expect(page).toContain("updateBellCount(unreadTotal)");
  expect(page).toContain("unreadTotal>0?");
  expect(page).toContain("data-read-notification");
  expect(page).toContain("action:'read_all'");
  expect(page).toContain("var safe=/^(#\\/[a-z0-9_/-]+|\\/match\\.html\\?id=[a-zA-Z0-9_-]+)$/i.test(target)?target:''");
  expect(page).not.toContain("async function loadNotificationsPage()");
});
