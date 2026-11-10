const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('CROWN owner panel disables scheduling while a defense is already pending', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  expect(page).toContain('if(pending.length){crownChallengerSelect.disabled=true');
  expect(page).toContain('crownChallengeForm.querySelector(\'button[type="submit"]\').disabled=true');
  expect(page).toContain('Сначала заверши её по подтверждённому результату или отмени');
});
