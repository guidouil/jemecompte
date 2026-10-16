import { hashAdminPassword } from '../src/lib/server/admin-auth';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required.');
process.env.DATABASE_URL = url;
process.env.ADMIN_DATABASE_URL = url;
process.env.ORIGIN = 'http://127.0.0.1:5176';
process.env.HOST = '127.0.0.1';
process.env.PORT = '5176';
process.env.REAL_EVENTS_APPROVED = 'false';
process.env.ADMIN_PASSWORD_HASH = await hashAdminPassword(process.env.TEST_ADMIN_PASSWORD ?? 'e2e-admin-password-local-only');
process.env.ADMIN_SESSION_SECRET = 'production-browser-test-secret-local-only-00000000';
const builtServer = new URL('../build/index.js', import.meta.url);
await import(builtServer.href);
export {};
