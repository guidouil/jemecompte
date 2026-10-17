import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inventory, isPublicSource, jsonBytes, MANIFEST_PATH, publicSourcePaths, readPublicSource, safeDirectory, sha256, writeOutputFile } from './release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
/** @param {string[]} args */
const git = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
/** @param {string | undefined} raw */
const canonicalOrigin = (raw) => { if (!raw) return null; const url = new URL(raw); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('ORIGIN must be a canonical public HTTP(S) origin'); return url.origin; };
const gitRoot = git(['rev-parse', '--show-toplevel']);
const ownsGitTree = gitRoot !== null && await realpath(gitRoot) === await realpath(root);
const head = ownsGitTree ? git(['rev-parse', 'HEAD']) : null;
const platformCommit = /^[a-f0-9]{40,64}$/.test(process.env.COMMIT_ID ?? '') ? process.env.COMMIT_ID ?? null : null;
const commit = head || platformCommit;
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) throw new Error('GitHub commit does not match checkout');
// Clever may retain Git but remove .nvmrc before its native Node build. Recover
// only this missing, regular tracked file from the platform's exact commit.
if (head && platformCommit === head && !process.env.GITHUB_SHA) {
  const nvmrc = new URL('../.nvmrc', import.meta.url);
  let missing = false;
  try { await lstat(nvmrc); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') missing = true; else throw error; }
  if (missing) {
    const entry = git(['ls-tree', head, '--', '.nvmrc']);
    if (!/^100(?:644|755) blob [a-f0-9]{40,64}\t\.nvmrc$/.test(entry || '')) throw new Error('Missing .nvmrc is not a regular file in the platform commit');
    const bytes = execFileSync('git', ['cat-file', 'blob', `${head}:.nvmrc`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    // Exclusive creation also refuses a file or link appearing after lstat.
    const output = await open(nvmrc, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry?.startsWith('100755 ') ? 0o755 : 0o644);
    try { await output.writeFile(bytes); } finally { await output.close(); }
  }
}
const tracked = ownsGitTree ? git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']) : null;
const sourceInventory = tracked === null ? 'public-filesystem' : 'git-visible';
const candidates = tracked === null
  ? await publicSourcePaths(root)
  : tracked.split('\0');
const sourcePaths = [...new Set(candidates.filter(isPublicSource))].sort();
const sources = [];
for (const relative of sourcePaths) {
  sources.push({ path: relative, sha256: sha256(await readPublicSource(root, relative)) });
}
const status = head ? git(['status', '--porcelain', '--untracked-files=all']) : null;
const dirty = status === null ? null : Boolean(status);
if (process.env.JEMECOMPTE_RELEASE === 'true' && (!head || dirty !== false || sourceInventory !== 'git-visible')) throw new Error('A release requires a clean Git checkout');
const sourceSha256 = sha256(jsonBytes(sources));
const origin = canonicalOrigin(process.env.ORIGIN);
if (process.env.JEMECOMPTE_RELEASE === 'true' && !origin?.startsWith('https://')) throw new Error('A published release requires its canonical HTTPS ORIGIN');
const difficulty = process.env.ADMISSION_DIFFICULTY ?? '18';
if (!/^(16|17|18|19|20)$/.test(difficulty)) throw new Error('Invalid public admission difficulty');
const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', cwd: root });
if (npm.status !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(npm.stdout)) throw new Error('Cannot identify npm version');
const run = process.env.GITHUB_REPOSITORY === 'guidouil/jemecompte' && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : null;
/** @type {import('../src/lib/shared/build-info').BuildInfo} */
const info = {
  schemaVersion: 1, repository: 'https://github.com/guidouil/jemecompte', commit,
  workingTree: dirty === null ? 'unavailable' : dirty ? 'modified' : 'clean', sourceInventory,
  sourceSha256, sourceFileCount: sources.length, lockSha256: sha256(await readPublicSource(root, 'package-lock.json')),
  node: process.version, npm: npm.stdout.trim(), origin,
  admissionDifficulty: Number(difficulty),
  builder: run ? 'github-actions' : platformCommit ? 'clever-cloud' : 'local',
  workflowRun: run ? `https://github.com/guidouil/jemecompte/actions/runs/${run}` : null,
  buildId: ''
};
info.buildId = sha256(jsonBytes({ commit, sourceSha256, origin, node: info.node, npm: info.npm, admissionDifficulty: info.admissionDifficulty })).slice(0, 32);
await safeDirectory(root, 'build');
await safeDirectory(root, '.svelte-kit');
const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, JEMECOMPTE_BUILD_INFO: JSON.stringify(info) }
});
if (result.status !== 0) process.exit(result.status || 1);
for (const source of sources) if (sha256(await readPublicSource(root, source.path)) !== source.sha256) throw new Error('Sources changed during build; rebuild before publication');
if (process.env.JEMECOMPTE_RELEASE === 'true' && git(['status', '--porcelain', '--untracked-files=all']) !== '') throw new Error('Git checkout changed during the release build');
const files = await inventory(root, ['build']);
await writeOutputFile(root, MANIFEST_PATH, jsonBytes({ schemaVersion: 1, scope: 'build-only', build: info, sources, files }));
console.log(`Public build manifest: ${MANIFEST_PATH} (${info.buildId}, ${info.workingTree})`);
