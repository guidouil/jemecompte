import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { record, recordDuration } from '#lib/server/observability';
import { sameAdminOrigin } from '#lib/server/admin-http';
import { localCanonicalRedirect } from '#lib/server/local-origin';

export const handle: Handle = async ({ event, resolve }) => {
  const started = performance.now();
  record('requests');
  try {
    // Route IDs also cover encoded aliases such as /%67ui that SvelteKit decodes.
    const privateAdministration = event.route?.id === '/gui' || event.route?.id?.startsWith('/gui/')
      || event.url.pathname === '/gui' || event.url.pathname.startsWith('/gui/');
    const localRedirect = localCanonicalRedirect(event);
    const response = localRedirect
      ? new Response(null, { status: 307, headers: { location: localRedirect, 'cache-control': 'no-store' } })
      : privateAdministration && event.request.method === 'POST' && !sameAdminOrigin(event)
        ? new Response('Requête refusée.', { status: 403 })
        : await resolve(event);
    if (privateAdministration) {
      response.headers.set('cache-control', 'private, no-store, max-age=0');
      response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
    }
    // Native form POSTs need their same-origin Origin header for the strict CSRF check.
    // No referrer is sent from the private page to another origin.
    response.headers.set('referrer-policy', privateAdministration ? 'same-origin' : 'no-referrer');
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('permissions-policy', 'geolocation=(self), camera=(), microphone=()');
    response.headers.set('x-frame-options', 'DENY');
    const protocol = process.env.ORIGIN ? new URL(process.env.ORIGIN).protocol : event.url.protocol;
    if (protocol === 'https:') response.headers.set('strict-transport-security', 'max-age=31536000');
    return response;
  } finally { recordDuration(performance.now() - started); }
};

export const handleError: HandleServerError = () => {
  record('server_error');
  return { message: 'Le service est momentanément indisponible. Réessayez dans un instant.' };
};
