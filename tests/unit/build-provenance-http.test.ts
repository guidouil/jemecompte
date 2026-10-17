import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegularFile } from '../../scripts/release-files.mjs';

vi.mock('../../scripts/release-files.mjs', () => ({ readRegularFile: vi.fn() }));
vi.mock('#lib/shared/build-info', () => ({ buildInfo: {
  schemaVersion: 1, repository: 'https://github.com/guidouil/jemecompte', commit: 'a'.repeat(40),
  buildId: 'public-build', workingTree: 'clean', sourceSha256: 'b'.repeat(64)
} }));
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe('public build provenance', () => {
  it('disables caches and exposes only selected public runtime configuration', async () => {
    const { GET } = await import('../../src/routes/api/version/+server');
    vi.stubEnv('DATABASE_URL', 'private-database-sentinel');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'private-admin-sentinel');
    vi.stubEnv('ADMISSION_SECRET', 'private-admission-sentinel');
    vi.stubEnv('ORIGIN', 'https://jemecompte.fr');
    vi.stubEnv('COMMIT_ID', 'a'.repeat(40));
    vi.stubEnv('COUNTER_EPOCH', '3');
    vi.stubEnv('ADMISSION_DIFFICULTY', '19');
    vi.mocked(readRegularFile).mockResolvedValue(Buffer.from(JSON.stringify({ schemaVersion: 1, scope: 'runtime-archive', build: { buildId: 'public-build' }, files: [{}], private: 'private-manifest-sentinel' })));
    const response = await GET({} as never);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.text();
    expect(body).not.toContain('sentinel');
    const parsed = JSON.parse(body);
    expect(parsed.runtime.configuration).toEqual({ origin: 'https://jemecompte.fr', realEventsApproved: false, counterEpoch: '3', admissionDifficulty: 19 });
    expect(parsed.manifest).toEqual({ scope: 'runtime-archive', fileCount: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await GET({} as never);
    expect(readRegularFile).toHaveBeenCalledTimes(1);
  });

  it('marks a missing or different manifest unavailable and drops invalid metadata', async () => {
    const { GET } = await import('../../src/routes/api/version/+server');
    vi.stubEnv('ORIGIN', 'https://private-sentinel@jemecompte.fr');
    vi.stubEnv('COMMIT_ID', 'private-sentinel');
    vi.stubEnv('COUNTER_EPOCH', 'private-sentinel');
    vi.mocked(readRegularFile).mockResolvedValue(Buffer.from(JSON.stringify({ schemaVersion: 1, scope: 'runtime-archive', build: { buildId: 'different' }, files: [{}] })));
    const response = await GET({} as never);
    const parsed = await response.json();
    expect(parsed.manifest).toBeNull();
    expect(parsed.runtime.platformCommit).toBeNull();
    expect(parsed.runtime.configuration.origin).toBeNull();
    expect(parsed.runtime.configuration.counterEpoch).toBeNull();
    vi.mocked(readRegularFile).mockRejectedValue(new Error('unavailable'));
    vi.resetModules();
    const { GET: unavailable } = await import('../../src/routes/api/version/+server');
    expect((await (await unavailable({} as never)).json()).manifest).toBeNull();
  });
});
