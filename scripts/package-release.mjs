import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inventory, jsonBytes, MANIFEST_PATH, newOutputFile, readPublicSource, readRegularFile, safeDirectory, sha256, verifyDirectory, writeOutputFile } from './release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = JSON.parse((await readRegularFile(root, MANIFEST_PATH)).toString('utf8'));
await verifyDirectory(root, original);
for (const source of original.sources) if (sha256(await readPublicSource(root, source.path)) !== source.sha256) throw new Error('Sources changed since build; rebuild before packaging');
if (sha256(await readPublicSource(root, 'package-lock.json')) !== original.build.lockSha256) throw new Error('Dependency lockfile changed since build');
if (process.env.JEMECOMPTE_RELEASE === 'true' && (original.build.workingTree !== 'clean' || original.build.builder !== 'github-actions')) throw new Error('Release publication requires a clean GitHub build');
const stage = new URL('../.release/runtime/', import.meta.url);
// lstat/rm must receive the path without a trailing slash: on POSIX, a trailing
// slash dereferences a symbolic directory even for lstat.
const stagePath = fileURLToPath(new URL('../.release/runtime', import.meta.url));
await safeDirectory(root, '.release');
try { const stat = await lstat(stagePath); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Runtime stage must be an ordinary directory'); }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
await rm(stagePath, { recursive: true, force: true });
await mkdir(stagePath);
await safeDirectory(root, 'build');
for (const name of ['package.json', 'package-lock.json']) await readRegularFile(root, name);
for (const name of ['build', 'package.json', 'package-lock.json']) await cp(new URL(`../${name}`, import.meta.url), new URL(name, stage), { recursive: true, verbatimSymlinks: true });
await mkdir(new URL('scripts/', stage));
for (const name of ['release-files.mjs', 'verify-release.mjs', 'verify-site.mjs']) {
  await readRegularFile(root, `scripts/${name}`);
  await cp(new URL(name, import.meta.url), new URL(`scripts/${name}`, stage), { verbatimSymlinks: true });
}
// This isolated installation contains only locked production packages. Lifecycle
// scripts cannot read build/deployment credentials, and no local node_modules is copied.
const install = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
if (install.status !== 0) process.exit(install.status || 1);
await writeOutputFile(fileURLToPath(stage), 'RUNNING.txt', 'Verify the archive attestation before extraction. Then run node scripts/verify-release.mjs . and configure secrets through the host environment. Start with node build. This archive does not attest the live server, database or configuration.\n');
const files = await inventory(fileURLToPath(stage));
const manifest = { ...original, scope: 'runtime-archive', files };
await writeOutputFile(fileURLToPath(stage), MANIFEST_PATH, jsonBytes(manifest));
await verifyDirectory(fileURLToPath(stage), manifest);
const name = `jemecompte-${original.build.commit || original.build.buildId}.tar.gz`;
const archive = await newOutputFile(root, `.release/${name}`);
let packed;
try { packed = spawnSync('tar', ['-cz', '-C', fileURLToPath(stage), '.'], { stdio: ['ignore', archive.fd, 'inherit'] }); }
finally { await archive.close(); }
if (packed.status !== 0) process.exit(packed.status || 1);
await writeOutputFile(root, '.release/SHA256SUMS', `${sha256(await readRegularFile(root, `.release/${name}`))}  ${name}\n`);
console.log(`Runtime archive: .release/${name}`);
