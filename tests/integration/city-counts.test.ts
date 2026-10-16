import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db';
import { executeCityCountsBatch, type CityCountConfiguration } from '../../src/lib/server/city-counts';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('City batch tests require a dedicated TEST_DATABASE_URL ending in _test.');
const previousDatabase = process.env.DATABASE_URL;
const previousApproval = process.env.REAL_EVENTS_APPROVED;
const ids: string[] = [];
const actor = { operator: 'city-batch-test', reason: 'Recette fictive isolée en base dédiée' };

function fixture(): CityCountConfiguration {
  const id = randomUUID(); ids.push(id);
  return {
    id, slug: `city-batch-${id}`, name: 'Comptage de ville fictif', cityCode: `T${id.slice(0, 8)}`, cityName: 'Ville fictive',
    description: 'Fixture dédiée aux tests, aucun rassemblement réel.', countingScope: 'city', isTest: false,
    geofence: { type: 'Polygon', coordinates: [[[2.36, 48.86], [2.37, 48.86], [2.37, 48.87], [2.36, 48.86]]] },
    startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString()
  };
}

async function state(eventIds: string[]) {
  return (await getPool().query(`SELECT id,slug,name,status,is_test,counting_scope,geofence_version,metadata_version,updated_at,
    (SELECT count(*)::text FROM admin_audit WHERE event_id=events.id) AS audits,
    (SELECT count(*)::text FROM presences WHERE event_id=events.id) AS presences,
    (SELECT count(*)::text FROM event_counters WHERE event_id=events.id) AS counters
    FROM events WHERE id=ANY($1::uuid[]) ORDER BY id`, [eventIds])).rows;
}

describe.skipIf(!testUrl)('atomic PostgreSQL city batch', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    await closeDatabase();
    await migrate();
  });
  beforeEach(() => { process.env.REAL_EVENTS_APPROVED = 'false'; });
  afterEach(async () => {
    const owned = ids.splice(0);
    for (const table of ['admin_audit', 'presences', 'event_counters'] as const) {
      await getPool().query(`DELETE FROM ${table} WHERE event_id=ANY($1::uuid[])`, [owned]);
    }
    await getPool().query('DELETE FROM events WHERE id=ANY($1::uuid[])', [owned]);
  });
  afterAll(async () => {
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousApproval === undefined) delete process.env.REAL_EVENTS_APPROVED; else process.env.REAL_EVENTS_APPROVED = previousApproval;
  });

  it('imports the twenty exact public city contours as drafts with zero presences and replays without touching versions or audits', async () => {
    const data = JSON.parse(await readFile(new URL('../../data/events/2026-10-17-cities.json', import.meta.url), 'utf8')) as CityCountConfiguration[];
    const configs = data.map((config) => {
      const id = randomUUID(); ids.push(id);
      return { ...config, id, slug: `${config.slug}-${id.slice(0, 8)}` };
    });
    expect(await executeCityCountsBatch(configs, 'apply', actor)).toMatchObject({ created: configs.map((config) => config.id), published: [], skipped: [] });
    const before = await state(ids);
    expect(before).toHaveLength(20);
    expect(before.every((row) => row.status === 'draft' && row.counting_scope === 'city' && !row.is_test && row.audits === '1' && row.presences === '0' && row.counters === '0')).toBe(true);
    expect(await executeCityCountsBatch(configs, 'apply', actor)).toMatchObject({ created: [], published: [], skipped: configs.map((config) => config.id) });
    expect(await state(ids)).toEqual(before);
  });

  it('publishes only through the explicit approved action and keeps repeated publication/import unchanged', async () => {
    const configs = [fixture(), fixture()];
    await executeCityCountsBatch(configs, 'apply', actor);
    await expect(executeCityCountsBatch(configs, 'publish', actor)).rejects.toThrow('désactivée');
    expect((await state(ids)).every((row) => row.status === 'draft')).toBe(true);
    process.env.REAL_EVENTS_APPROVED = 'true';
    expect(await executeCityCountsBatch(configs, 'publish', actor)).toMatchObject({ created: [], published: configs.map((config) => config.id), skipped: [] });
    const before = await state(ids);
    expect(before.every((row) => row.status === 'published' && row.metadata_version === 2 && row.geofence_version === 1 && row.audits === '2' && row.presences === '0' && row.counters === '0')).toBe(true);
    await executeCityCountsBatch(configs, 'publish', actor);
    await executeCityCountsBatch(configs, 'apply', actor);
    expect(await state(ids)).toEqual(before);
  });

  it('rejects a changed draft or published configuration atomically, without adding an earlier new entry', async () => {
    const existing = fixture();
    await executeCityCountsBatch([existing], 'apply', actor);
    const before = await state([existing.id]);
    const newEntry = fixture();
    await expect(executeCityCountsBatch([newEntry, { ...existing, name: 'Modification refusée' }], 'apply', actor)).rejects.toThrow('diffère');
    expect(await state(ids)).toEqual(before);
    process.env.REAL_EVENTS_APPROVED = 'true';
    await executeCityCountsBatch([existing], 'publish', actor);
    const published = await state([existing.id]);
    await expect(executeCityCountsBatch([{ ...existing, endsAt: new Date(Date.now() + 7_200_000).toISOString() }, newEntry], 'apply', actor)).rejects.toThrow('diffère');
    expect(await state(ids)).toEqual(published);
  });

  it('refuses a slug collision and an opposite test-mode identity without importing other entries', async () => {
    const existing = fixture();
    await executeCityCountsBatch([existing], 'apply', actor);
    const collision = { ...fixture(), slug: existing.slug };
    const untouched = fixture();
    await expect(executeCityCountsBatch([untouched, collision], 'apply', actor)).rejects.toThrow('lien');
    expect(await state(ids)).toHaveLength(1);
    await getPool().query('UPDATE events SET is_test=true WHERE id=$1', [existing.id]);
    await expect(executeCityCountsBatch([untouched, existing], 'apply', actor)).rejects.toThrow('mode opposé');
    expect(await state(ids)).toHaveLength(1);
  });

  it('does not partially publish when another entry is missing or expired, and never reopens a paused event', async () => {
    const existing = fixture();
    const missing = fixture();
    await executeCityCountsBatch([existing], 'apply', actor);
    process.env.REAL_EVENTS_APPROVED = 'true';
    await expect(executeCityCountsBatch([existing, missing], 'publish', actor)).rejects.toThrow('Importer');
    expect((await state(ids)).map((row) => row.status)).toEqual(['draft']);
    const expired = { ...fixture(), startsAt: new Date(Date.now() - 7_200_000).toISOString(), endsAt: new Date(Date.now() - 3_600_000).toISOString() };
    await executeCityCountsBatch([expired], 'apply', actor);
    await expect(executeCityCountsBatch([existing, expired], 'publish', actor)).rejects.toThrow('expiré');
    expect((await state(ids)).every((row) => row.status === 'draft')).toBe(true);
    await getPool().query("UPDATE events SET status='paused' WHERE id=$1", [existing.id]);
    await expect(executeCityCountsBatch([existing], 'publish', actor)).rejects.toThrow('suspendu');
    expect((await state([existing.id]))[0]?.status).toBe('paused');
  });

  it('serializes concurrent identical imports without duplicate rows, audits or version increments', async () => {
    const configs = [fixture(), fixture()];
    const replies = await Promise.all(Array.from({ length: 4 }, () => executeCityCountsBatch(configs, 'apply', actor)));
    expect(replies.flatMap((reply) => reply.created)).toHaveLength(2);
    expect(replies.flatMap((reply) => reply.skipped)).toHaveLength(6);
    expect((await state(ids)).every((row) => row.audits === '1' && row.metadata_version === 1 && row.geofence_version === 1 && row.presences === '0')).toBe(true);
  });

  it('replays uppercase UUID input against the canonical UUID returned by PostgreSQL', async () => {
    const config = fixture();
    const upper = { ...config, id: config.id.toUpperCase() };
    expect((await executeCityCountsBatch([upper], 'apply', actor)).created).toEqual([config.id]);
    const before = await state(ids);
    expect((await executeCityCountsBatch([upper], 'apply', actor)).skipped).toEqual([config.id]);
    expect(await state(ids)).toEqual(before);
  });
});
