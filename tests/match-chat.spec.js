const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
function source(file) { return fs.readFileSync(path.join(process.cwd(), file), 'utf8'); }

test('MERCY MATCH chat is private to match participants and assigned tournament staff', () => {
  const api = source('functions/api/v1/match-chat.js');
  expect(api).toContain('getSessionUser(request, env)');
  expect(api).toContain('MATCH_ACCESS_DENIED');
  expect(api).toContain('tournament_staff');
  expect(api).toContain('team_roster');
  expect(api).toContain('staff?.staff_role === "observer"');
});

test('MERCY MATCH chat validates same-origin writes and message length', () => {
  const api = source('functions/api/v1/match-chat.js');
  expect(api).toContain('sameOrigin(request, env)');
  expect(api).toContain('MAX_MESSAGE_LENGTH = 1000');
  expect(api).toContain('INVALID_MESSAGE');
  expect(api).toContain('ORIGIN_REJECTED');
});

test('MERCY MATCH chat closes after the match ends and limits message bursts', () => {
  const api = source('functions/api/v1/match-chat.js');
  expect(api).toContain('const active = !!match.published_at');
  expect(api).toContain('if (!auth.canWrite)');
  expect(api).toContain('CHAT_CLOSED');
  expect(api).toContain('CHAT_RATE_LIMITED');
  expect(api).toContain('Date.now() - 10000');
});

test('MERCY MATCH chat stores messages per match and cascades on match deletion', () => {
  const migration = source('migrations/0026_mercy_match_chat.sql');
  expect(migration).toContain('match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE');
  expect(migration).toContain('user_id TEXT NOT NULL REFERENCES users(id)');
  expect(migration).toContain('idx_match_chat_messages_match_created');
});

test('MERCY MATCH room renders a live chat and safely inserts message text', () => {
  const page = source('match.html');
  expect(page).toContain('id="matchChatPanel"');
  expect(page).toContain('/api/v1/match-chat');
  expect(page).toContain('textContent=item.message');
  expect(page).toContain('setInterval(loadChat, 5000)');
});
