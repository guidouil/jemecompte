import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { localCanonicalRedirect } from '../../src/lib/server/local-origin';
import { handle } from '../../src/hooks.server';

afterEach(() => vi.unstubAllEnvs());
const event = (url: string, method = 'GET') => ({ request: new Request(url, { method }) });

describe('local canonical origin', () => {
  it('redirects safe loopback aliases before rendering pages and retains the path and search', () => {
    vi.stubEnv('ORIGIN', 'http://127.0.0.1:5173');
    expect(localCanonicalRedirect(event('http://localhost:5173/gui?q=Paris&page=2'))).toBe('http://127.0.0.1:5173/gui?q=Paris&page=2');
    expect(localCanonicalRedirect(event('http://localhost:5173/creer', 'HEAD'))).toBe('http://127.0.0.1:5173/creer');
    expect(localCanonicalRedirect(event('http://[::1]:5173/gui'))).toBe('http://127.0.0.1:5173/gui');
    expect(localCanonicalRedirect(event('http://localhost:5173//evil.example/gui'))).toBe('http://127.0.0.1:5173//evil.example/gui');
    vi.stubEnv('ORIGIN', 'http://localhost:5173');
    expect(localCanonicalRedirect(event('http://127.0.0.1:5173/gui'))).toBe('http://localhost:5173/gui');
  });

  it('never redirects writes, foreign hosts, other ports, other schemes or production origins', () => {
    vi.stubEnv('ORIGIN', 'http://127.0.0.1:5173');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(localCanonicalRedirect(event('http://localhost:5173/gui?/login', method))).toBeUndefined();
    }
    for (const url of ['http://evil.example:5173/gui', 'http://localhost.evil.example:5173/gui', 'http://localhost:5175/gui', 'https://localhost:5173/gui', 'http://127.0.0.1:5173/gui']) {
      expect(localCanonicalRedirect(event(url))).toBeUndefined();
    }
    vi.stubEnv('ORIGIN', 'https://jemecompte.fr');
    expect(localCanonicalRedirect(event('http://localhost:5173/gui'))).toBeUndefined();
    vi.stubEnv('ORIGIN', '');
    expect(localCanonicalRedirect(event('http://localhost:5173/gui'))).toBeUndefined();
    vi.stubEnv('ORIGIN', 'invalid');
    expect(localCanonicalRedirect(event('http://localhost:5173/gui'))).toBeUndefined();
  });

  it('keeps the private redirect uncached and does not resolve data or accept a localhost POST', async () => {
    vi.stubEnv('ORIGIN', 'http://127.0.0.1:5173');
    const resolve = vi.fn();
    const incoming = { ...event('http://localhost:5173/gui'), url: new URL('http://localhost:5173/gui'), route: { id: '/gui' } } as RequestEvent;
    const redirect = await handle({ event: incoming, resolve } as unknown as Parameters<typeof handle>[0]);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('location')).toBe('http://127.0.0.1:5173/gui');
    expect(redirect.headers.get('cache-control')).toContain('no-store');
    expect(resolve).not.toHaveBeenCalled();
    const posted = { ...incoming, request: new Request('http://localhost:5173/gui?/login', { method: 'POST', headers: { origin: 'http://localhost:5173' } }) };
    const forbidden = await handle({ event: posted, resolve } as unknown as Parameters<typeof handle>[0]);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('location')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
