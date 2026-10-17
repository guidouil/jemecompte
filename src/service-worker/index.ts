import { self } from '$app/service-worker';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';
import {
  PUBLIC_CACHE_PREFIX, PUBLIC_CACHE_GENERATION, PUBLIC_PAGES, isPrivatePath, isProvenancePath,
  purgeObsoletePublicCaches, shouldHandlePublicRequest, shouldStorePublicResponse
} from './cache-policy';

const CACHE = `${PUBLIC_CACHE_PREFIX}${PUBLIC_CACHE_GENERATION}${version}`;
const STATIC = [...immutable, ...assets].map((asset) => `/${asset.path.replace(/^\//, '')}`)
  .filter((path) => !isPrivatePath(new URL(path, self.location.origin).pathname) && !isProvenancePath(new URL(path, self.location.origin).pathname));
const staticPaths = new Set(STATIC);
const DAY = 24 * 60 * 60_000;

async function remember(cache: Cache, request: Request, response: Response): Promise<void> {
  if (!shouldStorePublicResponse(request, response, self.location.origin, staticPaths)) return;
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
    await purgeObsoletePublicCaches(caches, CACHE);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!shouldHandlePublicRequest(request, self.location.origin, staticPaths)) return;
  const url = new URL(request.url);
  // In particular: /gui, legacy /admin, action queries, SSE, POSTs, status and metrics never use CacheStorage.
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
