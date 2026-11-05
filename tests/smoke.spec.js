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
