export const PUBLIC_CACHE_PREFIX = 'jemecompte-public-';
// A privacy boundary change gets a new namespace even when a deployment reuses an application version.
export const PUBLIC_CACHE_GENERATION = 'private-gui-v1-';
export const PUBLIC_PAGES = ['/', '/comment-ca-marche', '/confidentialite'];

/** Live provenance must always reach the network, even if accidentally allowlisted. */
export function isProvenancePath(pathname: string): boolean {
  let path: string;
  try { path = decodeURIComponent(pathname).replace(/\\/g, '/').toLowerCase(); }
  catch { return true; }
  return ['/api/version', '/transparence'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Never let a private route become cacheable through a future static-asset or page allowlist. */
export function isPrivatePath(pathname: string): boolean {
  let path = pathname;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch { return true; }
  path = path.replace(/\\/g, '/').toLowerCase();
  return ['/gui', '/admin'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function isPublicDynamicUrl(url: URL): boolean {
  if (isPrivatePath(url.pathname) || isProvenancePath(url.pathname)) return false;
  return PUBLIC_PAGES.includes(url.pathname) ||
    /^\/evenements\/[a-z0-9-]+$/.test(url.pathname) ||
    url.pathname === '/api/events' || /^\/api\/events\/[0-9a-f-]+\/counters$/.test(url.pathname);
}

export function shouldHandlePublicRequest(request: Pick<Request, 'method' | 'url'>, origin: string, staticPaths: ReadonlySet<string>): boolean {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== origin || url.search || isPrivatePath(url.pathname) || isProvenancePath(url.pathname)) return false;
  return staticPaths.has(url.pathname) || isPublicDynamicUrl(url);
}

export function shouldStorePublicResponse(
  request: Pick<Request, 'method' | 'url'>,
  response: Pick<Response, 'ok' | 'headers' | 'url'>,
  origin: string,
  staticPaths: ReadonlySet<string>
): boolean {
  if (!shouldHandlePublicRequest(request, origin, staticPaths) || !response.ok || /\bno-store\b/i.test(response.headers.get('cache-control') ?? '')) return false;
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== origin || isPrivatePath(finalUrl.pathname) || isProvenancePath(finalUrl.pathname)) return false;
  }
  return true;
}

/** Remove former app caches completely and scrub private entries from the retained cache as well. */
export async function purgeObsoletePublicCaches(storage: CacheStorage, currentCache: string): Promise<void> {
  for (const name of await storage.keys()) {
    if (!name.startsWith(PUBLIC_CACHE_PREFIX)) continue;
    if (name !== currentCache) { await storage.delete(name); continue; }
    const cache = await storage.open(name);
    for (const request of await cache.keys()) {
      if (isPrivatePath(new URL(request.url).pathname) || isProvenancePath(new URL(request.url).pathname)) await cache.delete(request);
    }
  }
}
