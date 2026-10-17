import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { verifyRelease } from './verify-release.mjs';

const root = path.resolve(process.argv[2] || '.release/runtime');
await verifyRelease(root);
const server = spawn(process.execPath, ['build'], {
  cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '5189', ORIGIN: 'http://127.0.0.1:5189' }
});
let exited = false;
let diagnostic = '';
server.on('exit', () => { exited = true; });
server.stderr.on('data', (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-2_000); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exited) throw new Error(`Runtime archive failed to start: ${diagnostic}`);
    try {
      const response = await fetch('http://127.0.0.1:5189/api/version', { signal: AbortSignal.timeout(300) });
      if (response.ok && (await response.json()).manifest?.scope === 'runtime-archive') { ready = true; break; }
    } catch { /* Wait for local startup only; no participant endpoint is used. */ }
    await setTimeout(100);
  }
  if (!ready) throw new Error('Runtime archive did not become ready');
  const result = await new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, [path.resolve('scripts/verify-site.mjs'), 'http://127.0.0.1:5189', root], { stdio: 'inherit' });
    verifier.once('error', reject); verifier.once('exit', resolve);
  });
  if (result !== 0) throw new Error('Runtime archive public-file verification failed');
} finally { server.kill('SIGTERM'); }
