const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('Cloudflare Pages build publishes the standalone MERCY MATCH route', () => {
  const build = fs.readFileSync(path.join(process.cwd(), 'scripts/build-pages.sh'), 'utf8');
  expect(build).toContain('cp "$ROOT_DIR/match.html" "$OUTPUT_DIR/match.html"');
});

test('all HTML entry points revalidate after a deployment', () => {
  const headers = fs.readFileSync(path.join(process.cwd(), '_headers'), 'utf8');
  const sections = headers.split(/\n(?=\/)/);

  for (const route of ['/', '/index.html', '/match.html', '/referee.html']) {
    const section = sections.find(block => block.trimStart().split('\n')[0] === route);
    expect(section, `missing cache policy for ${route}`).toContain('Cache-Control: no-cache');
  }
});
