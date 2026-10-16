// Preview is intentionally local; production uses its explicitly configured canonical ORIGIN.
process.env.ORIGIN = 'http://127.0.0.1:4173';
const { preview } = await import('vite');
const server = await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } });
server.printUrls();
