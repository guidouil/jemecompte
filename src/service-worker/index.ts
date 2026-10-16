import { self } from '$app/service-worker';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';

const PREFIX = 'jemecompte-public-';
const CACHE = `${PREFIX}${version}`;
const STATIC = [...immutable, ...assets].map((asset) => `/${asset.path.replace(/^\//, '')}`);
const staticPaths = new Set(STATIC);
const PUBLIC_PAGES = ['/', '/comment-ca-marche', '/confidentialite'];
const DAY = 24 * 60 * 60_000;

function cacheable(url: URL): boolean {
  return PUBLIC_PAGES.includes(url.pathname) ||
    /^\/evenements\/[a-z0-9-]+$/.test(url.pathname) ||
    url.pathname === '/api/events' || /^\/api\/events\/[0-9a-f-]+\/counters$/.test(url.pathname);
}

async function remember(cache: Cache, request: Request, response: Response): Promise<void> {
  if (!response.ok || response.headers.get('cache-control')?.includes('no-store')) return;
  const headers = new Headers(response.headers);
  headers.set('x-jemecompte-cached-at', String(Date.now()));
  headers.delete('content-length');
  headers.delete('content-encoding');
  await cache.put(request, new Response(response.clone().body, { status: response.status, headers }));
  const dynamicKeys = (await cache.keys()).filter((key) => !staticPaths.has(new URL(key.url).pathname));
  // Only public pages and bounded public snapshots; no participant history/outbox.
  for (const key of dynamicKeys.slice(0, Math.max(0, dynamicKeys.length - 24))) await cache.delete(key);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(STATIC);
    for (const path of PUBLIC_PAGES) {
      try {
        const request = new Request(new URL(path, self.location.origin));
        await remember(cache, request, await fetch(request));
      } catch { /* Initial connectivity may already be degraded. */ }
    }
  })());
  // No skipWaiting: do not replace the active client during a participation.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  if (!staticPaths.has(url.pathname) && !cacheable(url)) return;
  // In particular: SSE, POSTs, individual status and metrics never enter CacheStorage.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (staticPaths.has(url.pathname)) return await cache.match(request) ?? fetch(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(request, { signal: controller.signal });
      if (response.ok) event.waitUntil(remember(cache, request, response));
      return response;
    } catch {
      const cached = await cache.match(request);
      const cachedAt = Number(cached?.headers.get('x-jemecompte-cached-at') ?? 0);
      if (cached && Date.now() - cachedAt < DAY) return cached;
      if (cached) await cache.delete(request);
      if (request.mode === 'navigate') {
        return new Response('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hors connexion — JeMeCompte</title><h1>Vous êtes hors connexion.</h1><p>Votre présence ne peut pas être confirmée. Rouvrez JeMeCompte lorsque le réseau revient.</p></html>', {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        });
      }
      return new Response(JSON.stringify({ status: 'temporarily_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    } finally { clearTimeout(timeout); }
  })());
});
