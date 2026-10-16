import type { RequestEvent } from '@sveltejs/kit';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Resolve local host aliases before a page can submit a form from the wrong origin. */
export function localCanonicalRedirect(event: Pick<RequestEvent, 'request'>): string | undefined {
  if (!['GET', 'HEAD'].includes(event.request.method) || !process.env.ORIGIN) return;
  let canonical: URL;
  let incoming: URL;
  try {
    canonical = new URL(process.env.ORIGIN);
    incoming = new URL(event.request.url);
  } catch { return; }
  if (!loopbackHosts.has(canonical.hostname) || !loopbackHosts.has(incoming.hostname)
    || !['http:', 'https:'].includes(canonical.protocol)
    || incoming.protocol !== canonical.protocol || incoming.port !== canonical.port
    || incoming.origin === canonical.origin) return;
  const target = new URL(canonical.origin);
  // Assigning the path cannot turn a leading // into another destination host.
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target.href;
}
