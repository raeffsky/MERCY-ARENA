const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('MERCY CROWN cannot schedule a defense against an unpublished tournament match', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/crown.js'), 'utf8');
  expect(file).toContain('t.published_at AS tournament_published_at');
  expect(file).toContain('!match.tournament_published_at');
  expect(file).toContain('MATCH_NOT_ELIGIBLE');
});
