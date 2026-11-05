const { test, expect } = require('@playwright/test');

test.describe('MERCY ARENA public shell', () => {
  test('renders the season hub, match center and team ladder', async ({ page }) => {
    const runtimeErrors = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    await page.goto('/');
    await expect(page).toHaveTitle(/MERCY ARENA/);
    await expect(page.locator('#app')).toContainText('СЕЗОНЫ И ТУРНИРЫ');
    await expect(page.locator('#homeMatches')).toBeVisible();
    await expect(page.locator('#homeRankings')).toBeVisible();
    await expect(page.locator('#homeMatches')).toContainText(/DEMO|Демо-матч|Расписание временно недоступно/);
    expect(runtimeErrors).toEqual([]);
  });



  test('player registration accepts numeric MLBB and server IDs before lookup', async ({ page }) => {
    await page.route('**/api/v1/players**', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/teams**', route => route.fulfill({ json: { data: [] } }));
    let lookupPayload = null;
    await page.route('**/api/v1/mlbb-lookup', async route => {
      lookupPayload = route.request().postDataJSON();
      await route.fulfill({ json: { data: { game_id: '123456789', server_id: '1234', nickname: 'TestPlayer', verified: true } } });
    });

    await page.goto('/#/players');
    await page.getByRole('button', { name: /Создать профиль/ }).click();
    await page.locator('#playerCreateForm [name="game_id"]').fill('123456789');
    await page.locator('#playerCreateForm [name="server_id"]').fill('1234');
    await page.getByRole('button', { name: 'Проверить игровой аккаунт' }).click();

    await expect.poll(() => lookupPayload).toEqual({ game_id: '123456789', server_id: '1234' });
    await expect(page.locator('#submitPlayerRegistration')).toBeEnabled();
    await expect(page.locator('#mlbbLookupResult')).toContainText('TestPlayer');
  });


  test('public player profile displays verified match statistics', async ({ page }) => {
    await page.route(/\/api\/v1\/players\?id=123$/, route => route.fulfill({ json: { data: [{
      id: 123, nickname: 'ArenaPlayer', game_id: '123456789', role: 'MID', team_id: null,
      region: 'EU', avatar_url: null,
      stats: { matches_played: 12, wins: 9, losses: 3, points: 27, win_rate: 75 },
      recent_matches: [{ id: 1, opponent_name: 'Team B', tournament_title: 'Season Cup', scheduled_at: '2026-11-01T12:00:00Z', outcome: 'win', player_score: 2, opponent_score: 0 }]
    }] } }));
    await page.route('**/api/v1/teams**', route => route.fulfill({ json: { data: [] } }));

    await page.goto('/#/player/123');
    await expect(page.locator('#profileNickname')).toHaveText('ArenaPlayer');
    await expect(page.locator('#profileMmr')).toHaveText('12');
    await expect(page.locator('#profileBpr')).toHaveText('9');
    await expect(page.locator('#profileLevel')).toHaveText('27');
    await expect(page.locator('#profileKda')).toHaveText('75%');
    await page.locator('[data-profile-tab="history"]').click();
    await expect(page.locator('.profile-match-row')).toContainText('Team B');
    await expect(page.locator('.profile-match-row')).toContainText('2 : 0');
  });


  test('seasonal team rankings retain teams with zero verified matches', async ({ page }) => {
    const rankingRequests = [];
    await page.route('**/api/v1/seasons?limit=50', route => route.fulfill({ json: { data: [
      { id: 'season-1', title: 'Season One', status: 'active', starts_at: '2026-11-01' }
    ] } }));
    await page.route('**/api/v1/rankings**', async route => {
      const url = new URL(route.request().url());
      rankingRequests.push(url.search);
      if (url.searchParams.get('scope') === 'teams') {
        await route.fulfill({ json: { data: [
          { id: 42, name: 'Zero Match Club', tag: 'ZMC', matches_played: 0, wins: 0, losses: 0, points: 0, win_rate: 0 }
        ] } });
      } else {
        await route.fulfill({ json: { data: [] } });
      }
    });
    await page.route('**/api/v1/teams**', route => route.fulfill({ json: { data: [] } }));

    await page.goto('/#/rankings');
    await page.locator('[data-ranking-scope="teams"]').click();
    await expect(page.locator('#rankingRows')).toContainText('Zero Match Club');
    await page.locator('#rankingSeason').selectOption('season-1');
    await expect.poll(() => rankingRequests.some(q => q.includes('scope=teams') && q.includes('season_id=season-1'))).toBe(true);
    await expect(page.locator('#rankingRows')).toContainText('Zero Match Club');
    await expect(page.locator('#rankingRows')).toContainText('0');
  });

  test('notifications route renders a useful signed-out state', async ({ page }) => {
    await page.goto('/#/notifications');
    await expect(page.locator('#app')).toContainText('УВЕДОМЛЕНИЯ');
    await expect(page.locator('#notificationsRoot')).toBeVisible();
  });

  test('mobile menu opens, navigates and closes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const open = page.getByRole('button', { name: 'Открыть меню' });
    await expect(open).toBeVisible();
    await open.click();

    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/open/);
    await drawer.getByRole('link', { name: /Игроки/ }).click();
    await expect(page).toHaveURL(/#\/players$/);
    await expect(drawer).not.toHaveClass(/open/);
    await expect(page.locator('#app')).toContainText('ИГРОКИ');
  });

  test('drawer can be dismissed with its close control and backdrop', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Открыть меню' }).click();
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);

    await page.getByRole('button', { name: 'Открыть меню' }).click();
    await page.locator('#shade').click({ position: { x: 8, y: 400 } });
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  });
});
