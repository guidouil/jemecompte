import { createServer } from 'vite';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) {
  throw new Error('The browser test server requires a separate TEST_DATABASE_URL ending in _test.');
}
process.env.DATABASE_URL = testUrl;
process.env.REAL_EVENTS_APPROVED = 'false';
process.env.ORIGIN = 'http://127.0.0.1:5175';
const server = await createServer({ server: { host: '127.0.0.1', port: 5175, strictPort: true } });
await server.listen();
server.printUrls();
