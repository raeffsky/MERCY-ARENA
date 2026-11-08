const { test, expect } = require('@playwright/test');

test.describe('MERCY CROWN and SCOUT', () => {
  test('CROWN renders an empty state and historical champion data', async ({ page }) => {
    await page.route('**/api/v1/crown', route => route.fulfill({ json: { data: {
      current: { id: 1, team_id: 7, team_name: 'CROWN TEAM', team_tag: 'CRN', started_at: '2026-11-01T10:00:00Z', defenses_count: 2 },
      history: [{ id: 2, team_name: 'FORMER TEAM', team_tag: 'OLD', started_at: '2026-10-01T10:00:00Z', ended_at: '2026-11-01T10:00:00Z', defenses_count: 1 }],
      challenges: [{ id: 3, team_name: 'CHALLENGER', team_tag: 'CHL', status: 'pending' }]
    } } }));
    await page.route('**/api/v1/teams', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/me', route => route.fulfill({ json: { authenticated: false, is_owner: false } }));
    await page.goto('/#/crown');
    await expect(page.locator('#crownContent')).toContainText('CROWN TEAM');
    await expect(page.locator('#crownContent')).toContainText('CHALLENGER');
    await expect(page.locator('#crownContent')).toContainText('FORMER TEAM');
  });

  test('SCOUT renders verified player metrics and role filters', async ({ page }) => {
    await page.route('**/api/v1/scout?**', route => route.fulfill({ json: { data: [{
      id: 11, nickname: 'RISING STAR', game_id: '123456789', role: 'JUNGLE', region: 'EU',
      team_name: 'SCOUT TEAM', matches_played: 10, wins: 8, losses: 2, win_rate: 80
    }], meta: { count: 1, regions: ['EU'], scoring: 'verified' } } }));
    await page.goto('/#/scout');
    await expect(page.locator('#scoutResults')).toContainText('RISING STAR');
    await expect(page.locator('#scoutResults')).toContainText('80%');
    await expect(page.locator('#scoutRole')).toBeVisible();
    await expect(page.locator('#scoutRegion')).toContainText('EU');
  });
});
