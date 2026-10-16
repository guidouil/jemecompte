import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { closeDatabase, getPool } from '../src/lib/server/db/index';

export async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('jemecompte:migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS __jemecompte_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const directory = fileURLToPath(new URL('../drizzle/', import.meta.url));
    const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
    for (const filename of files) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const previous = await client.query<{ checksum: string }>('SELECT checksum FROM __jemecompte_migrations WHERE filename = $1', [filename]);
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) throw new Error('An applied migration changed; restore the original migration.');
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(source);
        await client.query('INSERT INTO __jemecompte_migrations (filename, checksum) VALUES ($1, $2)', [filename, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('jemecompte:migrations'))"); } finally { client.release(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await migrate(); console.log('Migrations appliquées.'); }
  catch { console.error('Échec des migrations. Vérifier la connexion et les migrations sans publier les paramètres SQL.'); process.exitCode = 1; }
  finally { await closeDatabase(); }
}
