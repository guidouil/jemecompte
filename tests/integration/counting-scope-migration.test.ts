import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, getPool } from '../../src/lib/server/db';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
const previousDatabase = process.env.DATABASE_URL;

describe.skipIf(!testUrl)('additive whole-commune scope migration', () => {
  beforeAll(async () => { process.env.DATABASE_URL = testUrl; await closeDatabase(); });
  afterAll(async () => {
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
  });

  it('preserves historical rows and counting data while constraining geometry by scope', async () => {
    const client = await getPool().connect();
    const schema = `scope_${randomUUID().replaceAll('-', '')}`;
    const id = randomUUID();
    const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const multi = { type: 'MultiPolygon', coordinates: [polygon.coordinates] };
    const migrations = await Promise.all(['0000_initial.sql', '0001_community_events.sql', '0002_public_event_wording.sql', '0003_counting_scope.sql']
      .map((filename) => readFile(new URL(`../../drizzle/${filename}`, import.meta.url), 'utf8')));
    try {
      await client.query('BEGIN');
      // Isolated transactional schema exercises the real migration against the previous schema.
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      for (const source of migrations.slice(0, 3)) await client.query(source);
      await client.query(`INSERT INTO events(id,slug,name,city_code,city_name,geofence,starts_at,ends_at,is_test)
        VALUES($1,$2,'Comptage fictif','00000','Commune fictive',$3::jsonb,'2026-10-17T05:00:00Z','2026-10-17T17:00:00Z',true)`,
      [id, `scope-${id}`, JSON.stringify(polygon)]);
      await client.query("INSERT INTO presences(event_id,anonymous_event_id,counting_day) VALUES($1,$2,'2026-10-17')", [id, randomBytes(32)]);
      await client.query("INSERT INTO event_counters(event_id,counting_day,count,revision) VALUES($1,'2026-10-17',1,7)", [id]);
      await client.query("INSERT INTO admin_audit(event_id,operator,action,reason) VALUES($1,'scope-test','import_draft','Synthetic migration fixture')", [id]);
      const before = (await client.query('SELECT * FROM events WHERE id=$1', [id])).rows[0];
      const related = async () => {
        const rows = [];
        for (const table of ['presences', 'event_counters', 'admin_audit']) {
          rows.push((await client.query(`SELECT * FROM ${table} WHERE event_id=$1`, [id])).rows);
        }
        return rows;
      };
      const relatedBefore = await related();
      await client.query(migrations[3]!);
      const { counting_scope, ...preserved } = (await client.query('SELECT * FROM events WHERE id=$1', [id])).rows[0];
      expect(counting_scope).toBe('gathering');
      expect(preserved).toEqual(before);
      expect(await related()).toEqual(relatedBefore);

      await client.query("UPDATE events SET counting_scope='city', geofence=$2::jsonb WHERE id=$1", [id, JSON.stringify(multi)]);
      expect((await client.query('SELECT counting_scope,geofence FROM events WHERE id=$1', [id])).rows[0])
        .toEqual({ counting_scope: 'city', geofence: multi });
      for (const update of [
        "UPDATE events SET counting_scope='gathering' WHERE id=$1",
        "UPDATE events SET counting_scope='region' WHERE id=$1",
        "UPDATE events SET geofence='{}'::jsonb WHERE id=$1"
      ]) {
        await client.query('SAVEPOINT invalid_scope');
        let rejected = false;
        try { await client.query(update, [id]); } catch { rejected = true; }
        await client.query('ROLLBACK TO SAVEPOINT invalid_scope');
        expect(rejected).toBe(true);
      }
      expect(await related()).toEqual(relatedBefore);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });
});
