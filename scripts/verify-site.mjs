import path from 'node:path';
import { sha256 } from './release-files.mjs';
import { verifyRelease } from './verify-release.mjs';

try {
  const origin = new URL(process.argv[2] || '');
  if (origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) || origin.href !== `${origin.origin}/`) throw new Error('Usage: node scripts/verify-site.mjs https://jemecompte.fr [extracted-artifact-directory]');
  const { manifest, manifestSha256 } = await verifyRelease(path.resolve(process.argv[3] || '.'));
  /** @param {string} relative @param {number} limit */
  async function fetchBytes(relative, limit) {
    const response = await fetch(new URL(relative, origin), { redirect: 'error', cache: 'no-store', headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${relative}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new Error(`Response too large: ${relative}`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const version = JSON.parse((await fetchBytes('/api/version', 64_000)).toString('utf8'));
  if (version.build?.buildId !== manifest.build.buildId || version.manifest?.sha256 !== manifestSha256) throw new Error('The server advertises a different build or manifest');
  // Adapter-generated .br/.gz siblings are transport variants, not public URLs.
  // Their on-disk bytes are checked by verifyRelease; HTTP comparisons use the
  // original resource with identity encoding.
  const assets = manifest.files.filter((entry) => entry.type === 'file' && entry.path.startsWith('build/client/') && !/\.(br|gz)$/.test(entry.path));
  if (!assets.length) throw new Error('No public client assets in the manifest');
  for (const entry of assets) {
    if (entry.type !== 'file') continue;
    const relative = `/${entry.path.slice('build/client/'.length).split('/').map(encodeURIComponent).join('/')}`;
    if (sha256(await fetchBytes(relative, entry.size + 1)) !== entry.sha256) throw new Error(`Public asset differs: ${relative}`);
  }
  console.log(`Verified ${assets.length} public client assets and the advertised manifest for ${manifest.build.commit || manifest.build.buildId}.`);
  console.log('This independent download bypasses browser/service-worker caches. It cannot inspect server code, prevent selective responses, or certify the database.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Site verification failed'); process.exitCode = 1; }
