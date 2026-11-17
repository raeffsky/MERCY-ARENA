const { test, expect } = require('@playwright/test');

test('ambient background stays behind interactive overlays', async ({ page }) => {
  await page.goto('/');

  const layers = await page.evaluate(() => {
    const zIndex = value => Number.parseInt(value, 10);
    return {
      particles: zIndex(getComputedStyle(document.body, '::before').zIndex),
      aurora: zIndex(getComputedStyle(document.body, '::after').zIndex),
      drawer: zIndex(getComputedStyle(document.querySelector('.drawer')).zIndex),
      notifications: zIndex(getComputedStyle(document.querySelector('.notification-panel')).zIndex)
    };
  });

  expect(layers.particles).toBeLessThan(layers.drawer);
  expect(layers.particles).toBeLessThan(layers.notifications);
  expect(layers.aurora).toBeLessThan(layers.drawer);
  expect(layers.aurora).toBeLessThan(layers.notifications);
});
