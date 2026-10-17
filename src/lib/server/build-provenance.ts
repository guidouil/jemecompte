import { createHash } from 'node:crypto';
import { readRegularFile } from '../../../scripts/release-files.mjs';
import { buildInfo } from '#lib/shared/build-info';

type ManifestSummary = { sha256: string; scope: string; fileCount: number };
let manifestRead: Promise<ManifestSummary | null> | null = null;
let manifestReadAt = 0;

function publicOrigin(value: string | undefined): string | null {
  try { const url = new URL(value || ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null; }
  catch { return null; }
}

async function readManifest(): Promise<ManifestSummary | null> {
  try {
    const file = await readRegularFile(process.cwd(), 'build/release-manifest.json');
    if (file.length <= 5_000_000) {
      const parsed = JSON.parse(file.toString('utf8'));
      if (parsed.schemaVersion === 1 && parsed.build?.buildId === buildInfo.buildId && Array.isArray(parsed.files) && ['build-only', 'runtime-archive'].includes(parsed.scope)) {
        return { sha256: createHash('sha256').update(file).digest('hex'), scope: parsed.scope, fileCount: parsed.files.length };
      }
    }
  } catch { /* A missing manifest is visible as unavailable, never as verified. */ }
  return null;
}

export async function publicBuildProvenance() {
  // Coalesce requests: the public endpoint never hashes a large dependency
  // inventory on every request. This internal five-second refresh is independent
  // of browser/proxy caching, which remains disabled.
  if (!manifestRead || Date.now() - manifestReadAt >= 5_000) {
    manifestReadAt = Date.now();
    manifestRead = readManifest();
  }
  const manifest = await manifestRead;
  return {
    schemaVersion: 1,
    build: buildInfo,
    manifest,
    runtime: {
      node: process.version,
      platformCommit: /^[a-f0-9]{40,64}$/.test(process.env.COMMIT_ID || '') ? process.env.COMMIT_ID! : null,
      configuration: {
        origin: publicOrigin(process.env.ORIGIN),
        realEventsApproved: process.env.REAL_EVENTS_APPROVED === 'true',
        admissionDifficulty: /^(16|17|18|19|20)$/.test(process.env.ADMISSION_DIFFICULTY ?? '18') ? Number(process.env.ADMISSION_DIFFICULTY ?? '18') : null,
        counterEpoch: /^[1-9]\d{0,127}$/.test(process.env.COUNTER_EPOCH ?? '1') ? process.env.COUNTER_EPOCH ?? '1' : null
      }
    },
    assurance: 'server-declaration; verify the release attestation and public assets independently; server execution and database are not remotely attested'
  };
}
