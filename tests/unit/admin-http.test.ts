import { afterEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { readAdminForm, sameAdminOrigin } from '../../src/lib/server/admin-http';
import { handle } from '../../src/hooks.server';

afterEach(() => vi.unstubAllEnvs());

it('requires the canonical origin and rejects cross-site administration POSTs', () => {
  vi.stubEnv('ORIGIN', 'https://jemecompte.fr');
  const event = (origin?: string, site?: string) => ({ url: new URL('http://internal/gui'), request: new Request('https://jemecompte.fr/gui', {
    method: 'POST', headers: { ...(origin ? { origin } : {}), ...(site ? { 'sec-fetch-site': site } : {}) }
  }) });
  expect(sameAdminOrigin(event('https://jemecompte.fr', 'same-origin'))).toBe(true);
  expect(sameAdminOrigin(event('https://other.example'))).toBe(false);
  expect(sameAdminOrigin(event())).toBe(false);
  expect(sameAdminOrigin(event('https://jemecompte.fr', 'cross-site'))).toBe(false);
});

it('parses native and enhanced forms with a bounded body', async () => {
  const enhanced = new FormData();
  enhanced.set('eventId', 'example');
  expect((await readAdminForm(new Request('http://local/gui', { method: 'POST', body: enhanced })))?.get('eventId')).toBe('example');
  expect((await readAdminForm(new Request('http://local/gui', { method: 'POST', body: new URLSearchParams({ confirmation: 'slug' }) })))?.get('confirmation')).toBe('slug');
  expect(await readAdminForm(new Request('http://local/gui', { method: 'POST', body: JSON.stringify({ password: 'secret' }), headers: { 'content-type': 'application/json' } }))).toBeUndefined();
  expect(await readAdminForm(new Request('http://local/gui', { method: 'POST', body: new URLSearchParams({ x: 'x'.repeat(2048) }) }))).toBeUndefined();
});

it('marks private pages/data/errors as no-store and blocks foreign POST before resolution', async () => {
  vi.stubEnv('ORIGIN', 'https://jemecompte.fr');
  for (const path of ['/gui', '/gui/__data.json', '/gui/missing', '/%67ui']) {
    const resolve = vi.fn(async () => new Response('private', { status: 404 }));
    const event = { route: { id: '/gui' }, url: new URL(`https://jemecompte.fr${path}`), request: new Request(`https://jemecompte.fr${path}`) } as RequestEvent;
    const response = await handle({ event, resolve } as unknown as Parameters<typeof handle>[0]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  }
  const resolve = vi.fn();
  const event = { url: new URL('https://jemecompte.fr/gui'), request: new Request('https://jemecompte.fr/gui?/delete', { method: 'POST', headers: { origin: 'https://evil.example' } }) } as RequestEvent;
  const response = await handle({ event, resolve } as unknown as Parameters<typeof handle>[0]);
  expect(response.status).toBe(403);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(resolve).not.toHaveBeenCalled();
});
