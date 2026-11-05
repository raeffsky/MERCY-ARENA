const { test, expect } = require('@playwright/test');

test.describe('MERCY ARENA public shell', () => {
  test('renders the home page and primary tournament action', async ({ page }) => {
    const runtimeErrors = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /Uncaught (?:SyntaxError|ReferenceError|TypeError)/.test(message.text())) {
        runtimeErrors.push(message.text());
      }
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/MERCY ARENA/);
    await expect(page.locator('#app')).toContainText('ТВОЙ ПУТЬ');
    await page.getByRole('link', { name: /Начать свой путь/i }).click();
    await expect(page).toHaveURL(/#\/tournaments$/);
    expect(runtimeErrors).toEqual([]);
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
