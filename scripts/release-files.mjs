import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, readlink, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** @typedef {{path: string, sha256: string}} SourceEntry */
/** @typedef {{path: string, type: 'file', size: number, executable: boolean, sha256: string} | {path: string, type: 'symlink', target: string, sha256: string}} FileEntry */
/** @typedef {{schemaVersion: number, scope: 'build-only' | 'runtime-archive', build: import('../src/lib/shared/build-info').BuildInfo, sources: SourceEntry[], files: FileEntry[]}} ReleaseManifest */

export const MANIFEST_PATH = 'build/release-manifest.json';
/** @param {string | Uint8Array} value */
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** @param {unknown} value */
export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** @param {unknown} value @returns {value is string} */
export function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') &&
    !path.posix.isAbsolute(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Refuse symbolic parents before any recursive deletion, copy or output creation.
 * @param {string} root @param {string} relative
 */
export async function safeDirectory(root, relative) {
  if (!safePath(relative)) throw new Error('Unsafe directory path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Directory must not be a symbolic link: ${relative}`);
  }
  return current;
}

/** @param {string} root @param {string} relative */
export async function regularFilePath(root, relative) {
  if (!safePath(relative)) throw new Error('Unsafe file path');
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Symbolic links or non-ordinary file/parent paths are forbidden: ${relative}`);
  }
  return current;
}

/** @param {string} root @param {string} relative */
export async function readRegularFile(root, relative) {
  const target = await regularFilePath(root, relative);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await file.readFile(); } finally { await file.close(); }
}

/** Open a new output without following an existing file/link.
 * @param {string} root @param {string} relative
 */
export async function newOutputFile(root, relative) {
  if (!safePath(relative)) throw new Error('Unsafe output path');
  const parent = path.posix.dirname(relative);
  if (parent !== '.') await safeDirectory(root, parent);
  const target = path.join(root, relative);
  try { await regularFilePath(root, relative); await unlink(target); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  return open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
}

/** @param {string} root @param {string} relative @param {string} content */
export async function writeOutputFile(root, relative, content) {
  const output = await newOutputFile(root, relative);
  try { await output.writeFile(content); } finally { await output.close(); }
}

// Only these public project inputs are inventoried. Never inspect local secrets,
// ignored operational files, .git, npm configuration or the process environment.
/** @param {string} value */
export function isPublicSource(value) {
  if (!safePath(value)) return false;
  const parts = value.split('/');
  if (parts.some((part, index) => /^(ops|secrets?|private|node_modules|build)$/i.test(part) ||
    (part.startsWith('.') && !(index === 0 && (part === '.github' || parts.length === 1 && ['.nvmrc', '.gitignore'].includes(part)))))) return false;
  return /^(src|scripts|static|drizzle|docs|tests|clevercloud)\//.test(value) || value.startsWith('.github/workflows/') ||
    /^(package(?:-lock)?\.json|vite\.config\.ts|vitest\.config\.ts|tsconfig\.json|playwright(?:\.production)?\.config\.ts|drizzle\.config\.ts|README\.md|SECURITY\.md|LICENSE|\.nvmrc|\.gitignore)$/.test(value);
}

/** @param {string} root */
export async function publicSourcePaths(root) {
  const paths = [];
  /** @param {string} relative */
  async function visit(relative) {
    const stat = await lstat(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not public source inputs: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        // Exclude before traversing or reading, including secrets nested in a source directory.
        if (isPublicSource(child)) await visit(child);
      }
    } else if (stat.isFile() && isPublicSource(relative)) paths.push(relative);
  }
  for (const directory of ['src', 'scripts', 'static', 'drizzle', 'docs', 'tests', 'clevercloud', '.github/workflows']) {
    try { await visit(directory); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  for (const name of await readdir(root)) if (!name.includes('/') && isPublicSource(name)) {
    const stat = await lstat(path.join(root, name));
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not public source inputs: ${name}`);
    if (stat.isFile()) paths.push(name);
  }
  return paths.sort();
}

/** @param {string} root @param {string} relative */
export async function readPublicSource(root, relative) {
  if (!isPublicSource(relative)) throw new Error('Excluded source input');
  return readRegularFile(root, relative);
}

/** @param {string} root @param {string[]} roots @param {Set<string>} excluded */
export async function inventory(root, roots = [''], excluded = new Set([MANIFEST_PATH])) {
  /** @type {FileEntry[]} */
  const entries = [];
  /** @param {string} relative */
  async function visit(relative) {
    if (relative && !safePath(relative)) throw new Error('Unsafe inventory path');
    if (excluded.has(relative)) { await regularFilePath(root, relative); return; }
    const target = path.join(root, relative);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const link = await readlink(target);
      const resolved = path.resolve(path.dirname(target), link);
      const boundary = `${path.resolve(root)}${path.sep}`;
      if (!resolved.startsWith(boundary)) throw new Error(`External symbolic link: ${relative}`);
      entries.push({ path: relative, type: 'symlink', target: link, sha256: sha256(link) });
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(target)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      entries.push({ path: relative, type: 'file', size: stat.size, executable: Boolean(stat.mode & 0o111), sha256: sha256(await readFile(target)) });
    } else throw new Error(`Unsupported file: ${relative}`);
  }
  for (const entry of roots) await visit(entry);
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/** @param {string} root @param {ReleaseManifest} manifest */
export async function verifyDirectory(root, manifest) {
  if (manifest.schemaVersion !== 1 || !['build-only', 'runtime-archive'].includes(manifest.scope) || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Unsupported release manifest');
  const expected = new Map();
  for (const entry of manifest.files) {
    if (!safePath(entry.path) || entry.path === MANIFEST_PATH || !/^[a-f0-9]{64}$/.test(entry.sha256) || expected.has(entry.path)) throw new Error('Invalid manifest entry');
    expected.set(entry.path, entry);
  }
  const actual = await inventory(root, manifest.scope === 'build-only' ? ['build'] : ['']);
  if (actual.length !== expected.size) throw new Error('Release contains missing or additional files');
  for (const entry of actual) {
    const wanted = expected.get(entry.path);
    if (!wanted || JSON.stringify(entry) !== JSON.stringify(wanted)) throw new Error(`Release file differs: ${entry.path}`);
  }
  return actual.length;
}
