import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db/index';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
const previousDatabase = process.env.DATABASE_URL;
const prefix = 'DÉMONSTRATION — ';
const oldCommunityDescription = 'Démonstration fictive créée publiquement. Ce lieu et ce périmètre sont déclarés par le créateur ; ils ne certifient aucune manifestation réelle.';
const neutralDescription = 'Événement créé publiquement. Nom, commune et périmètre déclarés par le créateur, sans vérification indépendante de leur correspondance.';
const seedName = 'DÉMONSTRATION FICTIVE — Place de la République';
const seedDescription = 'Événement de test fictif. Ces participations ne mesurent aucune manifestation réelle. La zone de démonstration se situe place de la République à Paris.';

interface EventState extends Record<string, unknown> {
  id: string; name: string; description: string | null; metadata_version: number; updated_at: Date;
}
function preservedColumns(row: EventState) {
  const { name, description, metadata_version, updated_at, ...rest } = row;
  return rest;
}

describe.skipIf(!testUrl)('generated event wording data migration', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    await closeDatabase();
    await migrate();
  });
  afterAll(async () => {
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
  });

  it('cleans only generated wording, preserves user text and counting data, and is idempotent', async () => {
    const fixtures = [
      { name: `${prefix}Services publics`, description: oldCommunityDescription, source: 'community', clean: true },
      { name: `${prefix}${prefix}Nom choisi`, description: oldCommunityDescription, source: 'community', clean: true },
      { name: `${prefix}Texte personnel`, description: 'Description personnalisée à préserver.', source: 'community', clean: false },
      { name: seedName, description: seedDescription, source: 'team', clean: true, seedAudit: true },
      { name: seedName, description: seedDescription, source: 'team', clean: false }
    ].map((fixture) => ({ ...fixture, id: randomUUID() }));
    const ids = fixtures.map((fixture) => fixture.id);
    const client = await getPool().connect();
    const events = async () => (await client.query<EventState>('SELECT * FROM events WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows;
    const related = async (connection: PoolClient) => {
      const result: Record<string, unknown> = {};
      for (const table of ['presences', 'event_counters', 'admin_audit'] as const) {
        result[table] = (await connection.query(`SELECT * FROM ${table} WHERE event_id=ANY($1::uuid[]) ORDER BY event_id`, [ids])).rows;
      }
      return result;
    };
    try {
      await client.query('BEGIN');
      for (const fixture of fixtures) {
        await client.query(`INSERT INTO events
          (id,slug,name,city_code,city_name,description,geofence,starts_at,ends_at,status,is_test,
            creation_source,creation_request_hash,metadata_version,updated_at)
          VALUES ($1,$2,$3,'75056','Paris',$4,$5::jsonb,'2030-01-01T12:00:00Z','2030-01-01T16:00:00Z',
            'published',true,$6,$7,7,'2020-01-01T00:00:00Z')`,
        [fixture.id, `${fixture.source === 'team' ? 'demonstration-republique' : 'wording'}-${fixture.id}`,
          fixture.name, fixture.description,
          JSON.stringify({ type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.86]]] }),
          fixture.source, fixture.source === 'community' ? randomBytes(32) : null]);
        await client.query("INSERT INTO presences(event_id,anonymous_event_id,counting_day) VALUES($1,$2,'2030-01-01')", [fixture.id, randomBytes(32)]);
        await client.query("INSERT INTO event_counters(event_id,counting_day,count,revision) VALUES($1,'2030-01-01',1,3)", [fixture.id]);
        if (fixture.seedAudit) await client.query(`INSERT INTO admin_audit(event_id,operator,action,reason,configuration)
          VALUES($1,'wording-migration-test','import_draft',
            'Création explicite d’une démonstration fictive, sans présence initiale',$2::jsonb)`,
        [fixture.id, JSON.stringify({ name: fixture.name, description: fixture.description })]);
      }
      const before = await events();
      const relatedBefore = await related(client);
      const migration = await readFile(new URL('../../drizzle/0002_public_event_wording.sql', import.meta.url), 'utf8');
      await client.query(migration);
      const after = await events();
      expect(after.map(preservedColumns)).toEqual(before.map(preservedColumns));
      for (const fixture of fixtures) {
        const original = before.find((row) => row.id === fixture.id)!;
        const changed = after.find((row) => row.id === fixture.id)!;
        if (!fixture.clean) { expect(changed).toEqual(original); continue; }
        expect(changed.name).toBe(fixture.source === 'community' ? fixture.name.slice(prefix.length) : 'Place de la République');
        expect(changed.description).toBe(fixture.source === 'community' ? neutralDescription : 'Zone de comptage située place de la République à Paris.');
        expect(changed.metadata_version).toBe(original.metadata_version + 1);
        expect(changed.updated_at.getTime()).toBeGreaterThan(original.updated_at.getTime());
      }
      expect(await related(client)).toEqual(relatedBefore);
      await client.query(migration);
      expect(await events()).toEqual(after);
      expect(await related(client)).toEqual(relatedBefore);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });
});
