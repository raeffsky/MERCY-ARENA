const { test, expect } = require('@playwright/test');

test('closed off-canvas panels cannot receive keyboard focus', async ({ page }) => {
  await page.route('**/api/v1/notifications?limit=8', route =>
    route.fulfill({ json: { data: [], meta: { unread: 0 } } })
  );
  await page.route('**/api/v1/notifications?limit=1', route =>
    route.fulfill({ json: { data: [], meta: { unread: 0 } } })
  );

  await page.goto('/');

  const drawer = page.locator('#drawer');
  const drawerLink = drawer.locator('a[data-route="home"]');
  const notificationPanel = page.locator('#notificationPanel');
  const notificationClose = page.locator('#notificationClose');

  await expect(drawer).toHaveCSS('visibility', 'hidden');
  await expect(notificationPanel).toHaveCSS('visibility', 'hidden');

  await drawerLink.evaluate(element => element.focus());
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(false);

  await notificationClose.evaluate(element => element.focus());
  expect(await notificationPanel.evaluate(element => element.contains(document.activeElement))).toBe(false);

  await page.getByRole('button', { name: 'Открыть меню' }).click();
  await expect(drawer).toHaveCSS('visibility', 'visible');
  await drawerLink.evaluate(element => element.focus());
  await expect(drawerLink).toBeFocused();

  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(drawer).toHaveCSS('visibility', 'hidden');

  await page.getByRole('button', { name: 'Открыть уведомления' }).click();
  await expect(notificationPanel).toHaveCSS('visibility', 'visible');
  await notificationClose.evaluate(element => element.focus());
  await expect(notificationClose).toBeFocused();

  await notificationClose.click();
  await expect(notificationPanel).toHaveCSS('visibility', 'hidden');
});
