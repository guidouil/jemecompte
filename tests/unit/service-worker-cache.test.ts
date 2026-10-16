import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CACHE_GENERATION, PUBLIC_CACHE_PREFIX, isPrivatePath, purgeObsoletePublicCaches,
  shouldHandlePublicRequest, shouldStorePublicResponse
} from '../../src/service-worker/cache-policy';

const origin = 'https://jemecompte.fr';
// Deliberately include private paths: the privacy boundary must override any future asset allowlist.
const staticPaths = new Set(['/app.js', '/gui', '/gui/__data.json', '/admin', '/admin/logo.svg']);
const request = (path: string, method = 'GET') => ({ method, url: new URL(path, origin).href });
const response = (path = '/', cacheControl = 'public, max-age=60') => ({
  ok: true, url: new URL(path, origin).href, headers: new Headers({ 'cache-control': cacheControl })
});

describe('private backoffice cache boundary', () => {
  it.each([
    '/gui', '/gui/', '/gui/login', '/gui/__data.json', '/gui/deep/__data.json',
    '/gui?/login', '/gui?/delete', '/gui/__data.json?x-sveltekit-invalidated=1',
    '/%67ui', '/gui%2F__data.json', '/%2567ui', '/GUI',
    '/admin', '/admin/__data.json', '/admin/logo.svg'
  ])('never handles, reads offline or stores %s even when allowlisted as static', (path) => {
    const target = request(path);
    expect(isPrivatePath(new URL(target.url).pathname)).toBe(true);
    expect(shouldHandlePublicRequest(target, origin, staticPaths)).toBe(false);
    expect(shouldStorePublicResponse(target, response(path), origin, staticPaths)).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('never handles private %s actions', (method) => {
    expect(shouldHandlePublicRequest(request('/gui?/delete', method), origin, staticPaths)).toBe(false);
    expect(shouldHandlePublicRequest(request('/gui', method), origin, staticPaths)).toBe(false);
  });

  it('does not store a public request redirected to a private page or marked no-store', () => {
    expect(shouldStorePublicResponse(request('/'), response('/gui'), origin, staticPaths)).toBe(false);
    expect(shouldStorePublicResponse(request('/'), response('/gui/login'), origin, staticPaths)).toBe(false);
    expect(shouldStorePublicResponse(request('/'), response('/admin'), origin, staticPaths)).toBe(false);
    expect(shouldStorePublicResponse(request('/'), response('/', 'private, NO-STORE'), origin, staticPaths)).toBe(false);
    expect(shouldStorePublicResponse(request('/'), response('https://elsewhere.example/gui'), origin, staticPaths)).toBe(false);
  });

  it('retains bounded public offline routes while excluding action queries, participant endpoints and other origins', () => {
    for (const path of ['/', '/comment-ca-marche', '/confidentialite', '/evenements/exemple', '/api/events', '/api/events/1234-abcd/counters', '/app.js']) {
      expect(shouldHandlePublicRequest(request(path), origin, staticPaths)).toBe(true);
      expect(shouldStorePublicResponse(request(path), response(path), origin, staticPaths)).toBe(true);
    }
    for (const path of ['/?/delete', '/api/events/1234/presences', '/api/events/1234/presence-status', '/api/events/1234/stream', '/internal/metrics', 'https://elsewhere.example/']) {
      expect(shouldHandlePublicRequest(request(path), origin, staticPaths)).toBe(false);
    }
    expect(isPrivatePath('/guide')).toBe(false);
    expect(isPrivatePath('/administration-public-guide')).toBe(false);
    expect(isPrivatePath('/%invalid')).toBe(true);
  });

  it('purges previous app caches and private entries from the retained generation without touching unrelated caches', async () => {
    const current = `${PUBLIC_CACHE_PREFIX}${PUBLIC_CACHE_GENERATION}test-version`;
    const old = `${PUBLIC_CACHE_PREFIX}test-version`;
    const stores = new Map<string, Set<string>>([
      [old, new Set(['/gui', '/'])],
      [current, new Set(['/', '/app.js', '/gui', '/gui/__data.json', '/gui?/delete', '/%67ui', '/admin/__data.json'])],
      ['unrelated-cache', new Set(['/gui'])]
    ]);
    const storage = {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => ({
        keys: async () => [...stores.get(name)!].map((path) => new Request(new URL(path, origin))),
        delete: async (entry: Request) => {
          const target = new URL(entry.url);
          return stores.get(name)!.delete(target.pathname + target.search);
        }
      })
    } as unknown as CacheStorage;
    await purgeObsoletePublicCaches(storage, current);
    expect(stores.has(old)).toBe(false);
    expect([...stores.get(current)!]).toEqual(['/', '/app.js']);
    expect([...stores.get('unrelated-cache')!]).toEqual(['/gui']);
  });
});
