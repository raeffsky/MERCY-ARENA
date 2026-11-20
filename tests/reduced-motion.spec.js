const { test, expect } = require('@playwright/test');

test('ambient background animations respect reduced-motion preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const animations = await page.evaluate(() => ({
    particles: getComputedStyle(document.body, '::before').animationName,
    aurora: getComputedStyle(document.body, '::after').animationName
  }));

  expect(animations.particles).toBe('none');
  expect(animations.aurora).toBe('none');
});
