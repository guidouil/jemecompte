import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE, ADMIN_IDLE_SECONDS, ADMIN_SESSION_SECONDS, AdminLoginLimiter, adminConfigured, clearAdminSession, createAdminSession, hashAdminPassword, revokeAdminSession, setAdminSession, validAdminSession, verifyAdminPassword } from '../../src/lib/server/admin-auth';

const password = 'a-private-test-passphrase-2026';
let hash: string;
beforeAll(async () => { hash = await hashAdminPassword(password); });
beforeEach(() => {
  vi.stubEnv('ADMIN_PASSWORD_HASH', hash);
  vi.stubEnv('ADMIN_SESSION_SECRET', 'test-session-secret-with-at-least-43-characters');
});
afterEach(() => vi.unstubAllEnvs());

describe('private administration password and session', () => {
  it('uses a salted scrypt hash, verifies the password and rejects invalid lengths', async () => {
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(hash).not.toContain(password);
    expect(await verifyAdminPassword(password)).toBe(true);
    expect(await verifyAdminPassword('different-long-test-passphrase')).toBe(false);
    expect(await verifyAdminPassword('short')).toBe(false);
    expect(await verifyAdminPassword('x'.repeat(257))).toBe(false);
    await expect(hashAdminPassword('short')).rejects.toThrow();
  });

  it('fails closed for absent or malformed environment configuration', async () => {
    expect(adminConfigured()).toBe(true);
    for (const value of ['', 'plain-text-is-not-a-hash', hash.replace('131072', '999999999')]) {
      vi.stubEnv('ADMIN_PASSWORD_HASH', value);
      expect(adminConfigured()).toBe(false);
      expect(await verifyAdminPassword(password)).toBe(false);
      expect(validAdminSession('anything')).toBe(false);
    }
    vi.stubEnv('ADMIN_PASSWORD_HASH', hash);
    vi.stubEnv('ADMIN_SESSION_SECRET', 'short');
    expect(adminConfigured()).toBe(false);
    expect(() => createAdminSession()).toThrow();
  });

  it('rejects tampering, expiry, future sessions and rotating either credential', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const session = createAdminSession(now);
    expect(validAdminSession(session, now)).toBe(true);
    expect(validAdminSession(session, now + ADMIN_SESSION_SECONDS * 1000)).toBe(false);
    expect(validAdminSession(session, now - 1000)).toBe(false);
    expect(validAdminSession(`${session.slice(0, -2)}xx`, now)).toBe(false);
    expect(validAdminSession(session.replace('v1.', 'v2.'), now)).toBe(false);
    expect(validAdminSession(undefined, now)).toBe(false);
    vi.stubEnv('ADMIN_PASSWORD_HASH', hash.replace(/.$/, hash.endsWith('a') ? 'b' : 'a'));
    expect(validAdminSession(session, now)).toBe(false);
    vi.stubEnv('ADMIN_PASSWORD_HASH', hash);
    vi.stubEnv('ADMIN_SESSION_SECRET', 'replacement-session-secret-with-at-least-43-chars');
    expect(validAdminSession(session, now)).toBe(false);
  });

  it('scopes the HttpOnly cookie to /gui and uses Secure behind the canonical HTTPS origin', () => {
    const set = vi.fn();
    vi.stubEnv('ORIGIN', 'https://jemecompte.fr');
    setAdminSession({ url: new URL('http://internal:3000/gui'), cookies: { set, get: () => undefined } } as unknown as Parameters<typeof setAdminSession>[0]);
    expect(set).toHaveBeenCalledWith(ADMIN_COOKIE, expect.any(String), {
      path: '/gui', httpOnly: true, sameSite: 'strict', secure: true, maxAge: ADMIN_SESSION_SECONDS
    });
  });

  it('revokes a copied token on logout while keeping another browser session valid', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const stolen = createAdminSession(now);
    const other = createAdminSession(now);
    expect(validAdminSession(stolen, now)).toBe(true);
    const removeCookie = vi.fn();
    clearAdminSession({ get: () => stolen, delete: removeCookie });
    expect(removeCookie).toHaveBeenCalledWith(ADMIN_COOKIE, { path: '/gui' });
    expect(validAdminSession(stolen, now + 1000)).toBe(false);
    expect(validAdminSession(other, now + 1000)).toBe(true);
    revokeAdminSession(other);
  });

  it('expires idle sessions, keeps an absolute one-hour deadline and invalidates previous login tokens', () => {
    const now = Date.parse('2026-10-17T13:00:00Z');
    const idle = createAdminSession(now);
    expect(validAdminSession(idle, now + ADMIN_IDLE_SECONDS * 1000)).toBe(false);
    const active = createAdminSession(now);
    for (let seconds = 600; seconds < ADMIN_SESSION_SECONDS; seconds += 600) {
      expect(validAdminSession(active, now + seconds * 1000)).toBe(true);
    }
    expect(validAdminSession(active, now + ADMIN_SESSION_SECONDS * 1000)).toBe(false);
    const previous = createAdminSession();
    const set = vi.fn();
    setAdminSession({ url: new URL('https://jemecompte.fr/gui'), cookies: { get: () => previous, set } } as unknown as Parameters<typeof setAdminSession>[0]);
    expect(validAdminSession(previous)).toBe(false);
    const replacement = set.mock.calls[0]![1];
    expect(validAdminSession(replacement)).toBe(true);
    revokeAdminSession(replacement);
  });

  it('requires an active session issued by this process after a restart', async () => {
    const now = Date.parse('2026-10-17T14:00:00Z');
    const token = createAdminSession(now);
    expect(validAdminSession(token, now)).toBe(true);
    vi.resetModules();
    const restarted = await import('../../src/lib/server/admin-auth');
    expect(restarted.validAdminSession(token, now)).toBe(false);
    revokeAdminSession(token);
  });
});

describe('administration attempt budget', () => {
  it('bounds the expensive hash to one active request and five attempts per peer per minute', () => {
    const limiter = new AdminLoginLimiter();
    const release = limiter.acquire('127.0.0.1', 1)!;
    expect(limiter.acquire('another-peer', 1)).toBeUndefined();
    release(); release();
    for (let attempt = 1; attempt < 5; attempt++) limiter.acquire('127.0.0.1', 1)!();
    expect(limiter.acquire('127.0.0.1', 1)).toBeUndefined();
    expect(limiter.acquire('127.0.0.1', 60_002)).toBeTypeOf('function');
  });

  it('bounds global attempts even when each request uses a different peer', () => {
    const limiter = new AdminLoginLimiter();
    for (let peer = 0; peer < 30; peer++) limiter.acquire(String(peer), 1)!();
    expect(limiter.acquire('new-peer', 1)).toBeUndefined();
  });

  it('keeps login and deletion attempt budgets separate while sharing the expensive-hash slot', () => {
    const limiter = new AdminLoginLimiter();
    for (let attempt = 0; attempt < 5; attempt++) limiter.acquire('127.0.0.1', 1)!();
    expect(limiter.acquire('127.0.0.1', 1)).toBeUndefined();
    const release = limiter.acquire('127.0.0.1', 1, 'delete');
    expect(release).toBeTypeOf('function');
    expect(limiter.acquire('another-peer', 1)).toBeUndefined();
    release!();
  });
});
