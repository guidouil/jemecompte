import { createServer } from 'vite';
import { hashAdminPassword } from '../src/lib/server/admin-auth';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) {
  throw new Error('The browser test server requires a separate TEST_DATABASE_URL ending in _test.');
}
process.env.DATABASE_URL = testUrl;
process.env.ADMIN_DATABASE_URL = testUrl;
process.env.REAL_EVENTS_APPROVED = 'false';
process.env.ORIGIN = 'http://127.0.0.1:5175';
// Dedicated browser-test credentials only, never inherited from a deployment.
process.env.ADMIN_PASSWORD_HASH = await hashAdminPassword(process.env.TEST_ADMIN_PASSWORD ?? 'e2e-admin-password-local-only');
process.env.ADMIN_SESSION_SECRET = 'browser-test-session-secret-local-only-000000000000';
// Fixed synthetic public provider data for browser creation tests; never call
// the government service or accept browser-provided communal geometry here.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'geo.api.gouv.fr' && url.pathname === '/communes/75056') {
    return new Response(JSON.stringify({ nom: 'Paris', code: '75056', centre: { type: 'Point', coordinates: [2.365,48.865] },
      contour: { type: 'Polygon', coordinates: [[[2.25,48.8],[2.45,48.8],[2.45,48.95],[2.25,48.95],[2.25,48.8]]] }
    }), { headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(input, init);
};
const server = await createServer({ server: { host: '127.0.0.1', port: 5175, strictPort: true } });
await server.listen();
server.printUrls();
