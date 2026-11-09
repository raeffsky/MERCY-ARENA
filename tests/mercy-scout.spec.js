const { test, expect } = require('@playwright/test');

test.describe('MERCY SCOUT', () => {
  test('renders verified player metrics and supports role and region filters', async ({ page }) => {
    const requests = [];
    await page.route('**/api/v1/scout?**', async route => {
      const url = new URL(route.request().url());
      requests.push({ role: url.searchParams.get('role'), region: url.searchParams.get('region'), sort: url.searchParams.get('sort') });
      await route.fulfill({ json: { data: [{
        id: 11, nickname: 'RISING STAR', game_id: '123456789', role: 'JUNGLE', region: 'EU',
        team_name: 'SCOUT TEAM', matches_played: 10, wins: 8, losses: 2, win_rate: 80
      }], meta: { count: 1, regions: ['EU'], scoring: 'verified' } } });
    });
    await page.goto('/#/scout');
    await expect(page.locator('#scoutResults')).toContainText('RISING STAR');
    await expect(page.locator('#scoutResults')).toContainText('80%');
    await expect(page.locator('#scoutRole')).toBeVisible();
    await expect(page.locator('#scoutRegion')).toContainText('EU');
    await page.locator('#scoutRole').selectOption('JUNGLE');
    await expect.poll(() => requests.some(x => x.role === 'JUNGLE')).toBe(true);
    await page.locator('#scoutRegion').selectOption('EU');
    await expect.poll(() => requests.some(x => x.region === 'EU')).toBe(true);
  });
});
