const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test.describe('MERCY ARENA session security', () => {
  test('session cookies are HttpOnly, Secure, SameSite=Lax and scoped to the site root', () => {
    const auth = source('functions/api/v1/_lib/session-auth.js');
    expect(auth).toContain('Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=');
    expect(auth).toContain('Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  });

  test('session tokens are stored only as SHA-256 hashes and expire server-side', () => {
    const auth = source('functions/api/v1/_lib/session-auth.js');
    const login = source('functions/api/v1/auth/login.js');
    expect(auth).toContain('crypto.subtle.digest("SHA-256"');
    expect(auth).toContain('s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?');
    expect(login).toContain('const tokenHash = await sha256(token)');
    expect(login).toContain('token_hash,expires_at');
    expect(login).not.toContain('INSERT INTO auth_sessions (id,user_id,token,');
  });

  test('login and logout require a matching Origin header', () => {
    const login = source('functions/api/v1/auth/login.js');
    const logout = source('functions/api/v1/auth/logout.js');
    expect(login).toContain('if (!origin || !sameOrigin(request, env))');
    expect(logout).toContain('if (!origin || !sameOrigin(request, env))');
  });

  test('login attempts are rate-limited by both normalized email and a salted IP hash', () => {
    const login = source('functions/api/v1/auth/login.js');
    expect(login).toContain('AUTH_RATE_LIMIT_SALT');
    expect(login).toContain('email_hash=? OR ip_hash=?');
    expect(login).toContain('now - 900');
    expect(login).toContain('>= 10');
    expect(login).toContain('LOGIN_RATE_LIMITED');
  });

  test('logout revokes the current session before clearing the browser cookie', () => {
    const logout = source('functions/api/v1/auth/logout.js');
    expect(logout).toContain('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL');
    expect(logout).toContain('clearSessionCookie()');
  });
});
