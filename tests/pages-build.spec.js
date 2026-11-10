const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('Cloudflare Pages build publishes the standalone MERCY MATCH route', () => {
  const build = fs.readFileSync(path.join(process.cwd(), 'scripts/build-pages.sh'), 'utf8');
  expect(build).toContain('cp "$ROOT_DIR/match.html" "$OUTPUT_DIR/match.html"');
});
