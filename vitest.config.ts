import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const local = loadEnv('test', process.cwd(), '');
if (!process.env.TEST_DATABASE_URL && local.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = local.TEST_DATABASE_URL;
}

export default defineConfig({
  resolve: { alias: { '#lib': fileURLToPath(new URL('./src/lib', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    restoreMocks: true
  }
});
