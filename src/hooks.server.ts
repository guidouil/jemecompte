import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { record, recordDuration } from '#lib/server/observability';

export const handle: Handle = async ({ event, resolve }) => {
  const started = performance.now();
  record('requests');
  try {
    const response = await resolve(event);
    response.headers.set('referrer-policy', 'no-referrer');
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
