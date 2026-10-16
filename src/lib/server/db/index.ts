import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema';

let pool: Pool | undefined;

/** Lazy: builds and prerendering must not need a database connection. */
export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for database operations.');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 15,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 8_000,
      idle_in_transaction_session_timeout: 10_000,
      application_name: 'jemecompte'
    });
    // Do not emit raw pg errors: messages can contain SQL values/identifiers.
    pool.on('error', () => { /* A subsequent operation exposes a sanitized unavailable state. */ });
  }
  return pool;
}

export function getDb() { return drizzle(getPool(), { schema }); }
export type DatabaseConnection = Pool | PoolClient;

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}

export function counterEpoch(): string {
  const value = process.env.COUNTER_EPOCH ?? '1';
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('COUNTER_EPOCH must be a positive decimal integer.');
  return value;
}

export function realEventsApproved(): boolean { return process.env.REAL_EVENTS_APPROVED === 'true'; }

export function isEventId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function decodeAnonymousEventId(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value ? decoded : null;
}
