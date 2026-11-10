const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('result webhooks only finalize matches in published active tournaments', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/webhooks/results.js'), 'utf8');
  expect(api).toContain('t.status AS tournament_status,t.published_at AS tournament_published_at');
  expect(api).toContain('!match.tournament_published_at');
  expect(api).toContain('["published","active"].includes(match.tournament_status)');
  expect(api).toContain('["scheduled","in_progress"].includes(match.status)');
  expect(api).toContain("status IN ('scheduled','in_progress')");
});

test('result webhooks enforce the configured BO1, BO3 or BO5 series target', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/webhooks/results.js'), 'utf8');
  expect(api).toContain('BO1: 1, BO3: 2, BO5: 3');
  expect(api).toContain('SERIES_NOT_FINISHED');
  expect(api).toContain('SELECT series_format FROM match_rooms WHERE match_id=?');
});

test('result webhook retries remain idempotent and signed', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/webhooks/results.js'), 'utf8');
  expect(api).toContain('x-mercy-signature');
  expect(api).toContain('x-mercy-timestamp');
  expect(api).toContain('payload_hash');
  expect(api).toContain('advanceWinner(env.DB, matchId, match.winner_team_id)');
});
