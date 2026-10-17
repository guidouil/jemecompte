import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_PATH, readRegularFile, sha256, verifyDirectory } from './release-files.mjs';

/** @param {string} root */
export async function verifyRelease(root) {
  const bytes = await readRegularFile(root, MANIFEST_PATH);
  /** @type {import('./release-files.mjs').ReleaseManifest} */
  const manifest = JSON.parse(bytes.toString('utf8'));
  const count = await verifyDirectory(root, manifest);
  return { manifest, manifestSha256: sha256(bytes), count };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { manifest, manifestSha256, count } = await verifyRelease(path.resolve(process.argv[2] || '.'));
    console.log(`Verified ${count} files (${manifest.scope}). Manifest SHA-256: ${manifestSha256}`);
    console.log(`Commit: ${manifest.build.commit || 'unavailable'}; source tree: ${manifest.build.workingTree}`);
    console.log('This checks bytes against the supplied manifest. Verify the archive attestation separately; this does not prove which code a remote server runs.');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Release verification failed'); process.exitCode = 1; }
}
