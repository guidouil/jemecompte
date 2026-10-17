import { spawnSync } from 'node:child_process';

// SvelteKit embeds paths.origin at build time. Build the browser fixture for its
// actual loopback origin so native form CSRF checks exercise the production code.
const fixtureOrigin = 'http://127.0.0.1:5176';
const steps = [
  ['scripts/build-release.mjs'],
  ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.production.config.ts', ...process.argv.slice(2)]
];
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ORIGIN: fixtureOrigin } });
  if (result.error || result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}
