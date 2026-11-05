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


  test('notifications route renders a useful signed-out state', async ({ page }) => {
    await page.goto('/#/notifications');
    await expect(page.locator('#app')).toContainText('УВЕДОМЛЕНИЯ');
    await expect(page.locator('#notificationsRoot')).toContainText(/Войди в аккаунт|Пока нет уведомлений/);
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
