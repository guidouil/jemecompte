import { afterEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { inventory, isPublicSource, jsonBytes, MANIFEST_PATH, publicSourcePaths, readPublicSource, readRegularFile, safePath, sha256, verifyDirectory, writeOutputFile } from '../../scripts/release-files.mjs';
import { verifyRelease } from '../../scripts/verify-release.mjs';
import type { ReleaseManifest } from '../../scripts/release-files.mjs';

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jemecompte-release-'));
  directories.push(root);
  await mkdir(path.join(root, 'build/client'), { recursive: true });
  await writeFile(path.join(root, 'build/client/app.js'), 'export const count = 0;\n');
  return root;
}
async function manifest(root: string): Promise<ReleaseManifest> {
  return { schemaVersion: 1, scope: 'build-only', sources: [], build: {} as ReleaseManifest['build'], files: await inventory(root, ['build']) };
}
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('public source and release inventories', () => {
  it('excludes private paths before reading source bytes and handles URL-special file names literally', async () => {
    for (const name of ['.env', '.env.example', '.git/config', 'ops/report.md', 'src/.env', 'src/.ENV', 'src/.npmrc', 'src/.codex/config.toml', 'src/secrets/key.ts', 'node_modules/a.js']) expect(isPublicSource(name)).toBe(false);
    for (const name of ['../src/file.ts', '/src/file.ts', 'src//file.ts', 'src/../file.ts', 'src\\file.ts']) expect(safePath(name)).toBe(false);
    const root = await fixture();
    await mkdir(path.join(root, 'src/.env.local'), { recursive: true });
    await writeFile(path.join(root, 'src/.env.local/secret.ts'), 'private sentinel');
    await writeFile(path.join(root, 'src/a#b?%.ts'), 'public input');
    expect(await publicSourcePaths(root)).toEqual(['src/a#b?%.ts']);
    expect((await readPublicSource(root, 'src/a#b?%.ts')).toString()).toBe('public input');
    await expect(readPublicSource(root, 'src/.env.local/secret.ts')).rejects.toThrow('Excluded');
  });

  it('detects modified bytes, extra files, removed files and executable permission changes', async () => {
    const root = await fixture();
    const expected = await manifest(root);
    expect(await verifyDirectory(root, expected)).toBe(1);
    await writeFile(path.join(root, 'build/client/app.js'), 'tampered');
    await expect(verifyDirectory(root, expected)).rejects.toThrow('differs');
    await writeFile(path.join(root, 'build/client/app.js'), 'export const count = 0;\n');
    await chmod(path.join(root, 'build/client/app.js'), 0o755);
    await expect(verifyDirectory(root, expected)).rejects.toThrow('differs');
    await chmod(path.join(root, 'build/client/app.js'), 0o644);
    await writeFile(path.join(root, 'build/extra.js'), 'unexpected');
    await expect(verifyDirectory(root, expected)).rejects.toThrow('additional');
    await rm(path.join(root, 'build/extra.js'));
    await rm(path.join(root, 'build/client/app.js'));
    await expect(verifyDirectory(root, expected)).rejects.toThrow('missing');
  });

  it('rejects unsafe manifest paths and links leaving the artifact', async () => {
    const root = await fixture();
    const expected = await manifest(root);
    expected.files[0]!.path = '../outside';
    await expect(verifyDirectory(root, expected)).rejects.toThrow('Invalid');
    await symlink('/etc/passwd', path.join(root, 'build/client/external'));
    await expect(inventory(root, ['build'])).rejects.toThrow('External symbolic link');
  });

  it('does not follow symbolic source parents into local private files', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'ops'));
    await writeFile(path.join(root, 'ops/key.ts'), 'private sentinel');
    await symlink('../ops', path.join(root, 'src/private-alias'));
    await expect(readPublicSource(root, 'src/private-alias/key.ts')).rejects.toThrow('Symbolic');
    await expect(publicSourcePaths(root)).rejects.toThrow('Symbolic');
  });

  it.each(['package.json', 'vite.config.ts'])('refuses a symbolic root source %s in the Clever filesystem fallback', async (name) => {
    const root = await fixture();
    const external = await fixture();
    await writeFile(path.join(external, 'source'), 'private sentinel');
    await symlink(path.join(external, 'source'), path.join(root, name));
    await expect(publicSourcePaths(root)).rejects.toThrow('Symbolic');
  });

  it('refuses a symbolic manifest during reading, inventory and replacement', async () => {
    const root = await fixture();
    const external = await fixture();
    const sentinel = path.join(external, 'manifest.json');
    await writeFile(sentinel, 'external sentinel');
    await symlink(sentinel, path.join(root, MANIFEST_PATH));
    await expect(readRegularFile(root, MANIFEST_PATH)).rejects.toThrow('Symbolic');
    await expect(verifyRelease(root)).rejects.toThrow('Symbolic');
    await expect(inventory(root, ['build'])).rejects.toThrow('Symbolic');
    await expect(writeOutputFile(root, MANIFEST_PATH, 'replacement')).rejects.toThrow('Symbolic');
    expect(await readFile(sentinel, 'utf8')).toBe('external sentinel');
    await rm(path.join(root, 'build'), { recursive: true });
    await symlink(path.join(external, 'build'), path.join(root, 'build'));
    await expect(readRegularFile(root, 'build/client/app.js')).rejects.toThrow('Symbolic');
    await expect(writeOutputFile(root, MANIFEST_PATH, 'replacement')).rejects.toThrow('symbolic');
  });

  it.each(['.release', '.release/runtime'])('rejects symbolic packaging parent %s before removing or copying anything', async (alias) => {
    const root = await fixture();
    const external = await fixture();
    await mkdir(path.join(external, 'runtime'));
    await writeFile(path.join(external, 'runtime/sentinel'), 'preserve outside runtime');
    await mkdir(path.join(root, 'scripts'));
    for (const name of ['package-release.mjs', 'release-files.mjs']) await copyFile(new URL(`../../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
    await writeFile(path.join(root, 'package-lock.json'), 'locked fixture');
    const expected = await manifest(root);
    expected.build.lockSha256 = sha256('locked fixture');
    await writeFile(path.join(root, MANIFEST_PATH), jsonBytes(expected));
    if (alias === '.release/runtime') await mkdir(path.join(root, '.release'));
    await symlink(alias === '.release' ? external : path.join(external, 'runtime'), path.join(root, alias));
    const run = spawnSync(process.execPath, ['scripts/package-release.mjs'], { cwd: root, env: { ...process.env, JEMECOMPTE_RELEASE: 'false' }, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ordinary directory|symbolic link/);
    expect(await readFile(path.join(external, 'runtime/sentinel'), 'utf8')).toBe('preserve outside runtime');
  });

  it('requires a clean tracked checkout for publication and inventories only public build inputs', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'scripts'));
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'node_modules/vite/bin'), { recursive: true });
    for (const name of ['build-release.mjs', 'package-release.mjs', 'release-files.mjs']) await copyFile(new URL(`../../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\nbuild/\n.env*\n');
    await writeFile(path.join(root, '.env.private'), 'PRIVATE_TEST_SENTINEL');
    await writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}');
    await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;');
    // A compiler fixture exercises wrapper metadata and release gating without
    // building the application or accessing any test/production database.
    await writeFile(path.join(root, 'node_modules/vite/bin/vite.js'), "const fs = require('node:fs'); fs.mkdirSync('build/client', {recursive:true}); fs.writeFileSync('build/client/build-info.json', process.env.JEMECOMPTE_BUILD_INFO);");
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture']);
    const env = { ...process.env, GITHUB_SHA: '', JEMECOMPTE_RELEASE: 'true', ORIGIN: 'https://example.invalid', DATABASE_URL: 'PRIVATE_TEST_SENTINEL' };
    const run = () => spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: root, env, encoding: 'utf8' });
    const clean = run();
    expect(clean.status, clean.stderr).toBe(0);
    const bytes = await readFile(path.join(root, 'build/release-manifest.json'), 'utf8');
    expect(bytes).not.toContain('PRIVATE_TEST_SENTINEL');
    const produced = JSON.parse(bytes) as ReleaseManifest;
    expect(produced.build.workingTree).toBe('clean');
    expect(produced.sources.map((source) => source.path)).toContain('src/a.ts');
    expect(produced.sources.some((source) => source.path.includes('.env'))).toBe(false);
    await writeFile(path.join(root, 'src/untracked.ts'), 'new source');
    expect(run().stderr).toContain('clean Git checkout');
    const localEnv = { ...env, JEMECOMPTE_RELEASE: 'false' };
    const local = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: root, env: localEnv, encoding: 'utf8' });
    expect(local.status, local.stderr).toBe(0);
    const localManifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), 'utf8')) as ReleaseManifest;
    expect(localManifest.build.workingTree).toBe('modified');
    expect(localManifest.sources.map((source) => source.path)).toContain('src/untracked.ts');
    await writeFile(path.join(root, 'src/untracked.ts'), 'changed after local build');
    const mixed = spawnSync(process.execPath, ['scripts/package-release.mjs'], { cwd: root, env: localEnv, encoding: 'utf8' });
    expect(mixed.stderr).toContain('Sources changed since build');
    await rm(path.join(root, 'src/untracked.ts'));
    await writeFile(path.join(root, 'src/a.ts'), 'modified source');
    expect(run().stderr).toContain('clean Git checkout');
  });
});
