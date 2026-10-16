import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db';
import { changeEventStatus, importEventConfiguration } from '../../src/lib/server/db/admin';
import { getEventBySlug } from '../../src/lib/server/events';
import { getNationalTotal } from '../../src/lib/server/counters';
import { getPresenceStatus, registerPresence } from '../../src/lib/server/participation';
import { invalidatePublicCatalogue, publicCatalogue, publicCounterSnapshot, publicNationalTotal } from '../../src/lib/server/public-data';
import { counterStream } from '../../src/lib/server/realtime';
import { load } from '../../src/routes/+page.server';
import type { ParticipationPayload } from '../../src/lib/shared/types';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required.');
const previousDatabase = process.env.DATABASE_URL;
const previousApproval = process.env.REAL_EVENTS_APPROVED;
const ids: string[] = [];
const actor = { operator: 'public-mode-integration', reason: 'Synthetic fixture in the dedicated test database' };
const payload = (): ParticipationPayload => ({
  anonymousEventId: randomBytes(32).toString('base64url'), geofenceVersion: 1, protocolVersion: 1, insideZone: true
});

async function fixture(isTest: boolean) {
  const id = randomUUID();
  ids.push(id);
  await importEventConfiguration({
    id, slug: `mode-${id}`, name: 'Comptage fictif de recette', cityCode: '75056', cityName: 'Paris', isTest,
    startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    geofence: { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]]] }
  }, actor);
  await changeEventStatus(id, 'publish', actor);
  return id;
}

describe.skipIf(!testUrl)('public test/real separation on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.REAL_EVENTS_APPROVED = 'true';
    await closeDatabase();
    await migrate();
  });
  afterAll(async () => {
    for (const id of ids) {
      await getPool().query('DELETE FROM admin_audit WHERE event_id=$1', [id]);
      await getPool().query('DELETE FROM presences WHERE event_id=$1', [id]);
      await getPool().query('DELETE FROM event_counters WHERE event_id=$1', [id]);
      await getPool().query('DELETE FROM events WHERE id=$1', [id]);
    }
    invalidatePublicCatalogue();
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousApproval === undefined) delete process.env.REAL_EVENTS_APPROVED; else process.env.REAL_EVENTS_APPROVED = previousApproval;
  });

  it('aligns home, catalogue, direct links, snapshots, streams and private HTTP services without merging fixtures', async () => {
    const test = await fixture(true);
    const real = await fixture(false);
    const testIdentity = payload();
    const realIdentity = payload();
    await registerPresence(test, testIdentity);
    await registerPresence(real, realIdentity);
    await registerPresence(real, payload());

    for (const isTest of [true, false, true]) {
      process.env.REAL_EVENTS_APPROVED = String(!isTest);
      const visible = isTest ? test : real;
      const hidden = isTest ? real : test;
      const expected = await getNationalTotal(isTest);
      const catalogue = await publicCatalogue();
      expect(catalogue.some((event) => event.id === visible)).toBe(true);
      expect(catalogue.some((event) => event.id === hidden)).toBe(false);
      expect(catalogue.every((event) => event.isTest === isTest)).toBe(true);
      expect((await getEventBySlug(`mode-${visible}`))?.id).toBe(visible);
      expect(await getEventBySlug(`mode-${hidden}`)).toBeNull();
      expect(await publicCounterSnapshot(hidden)).toBeNull();
      expect((await publicCounterSnapshot(visible))?.nationalTotal).toBe(expected);
      expect(await publicNationalTotal()).toBe(expected);
      expect((await load()).nationalTotal).toBe(expected);
      expect((await load()).events.every((event) => event.isTest === isTest)).toBe(true);

      const identity = isTest ? realIdentity : testIdentity;
      expect(await getPresenceStatus(hidden, identity.anonymousEventId, isTest)).toBeNull();
      expect(await registerPresence(hidden, payload(), isTest)).toEqual({ status: 'not_found' });
      const controller = new AbortController();
      try {
        expect(await counterStream(hidden, controller.signal)).toBeNull();
        const response = await counterStream(visible, controller.signal);
        const frame = await response?.body?.getReader().read();
        const text = new TextDecoder().decode(frame?.value);
        const data = text.split('\n').find((line) => line.startsWith('data: '));
        expect(data).toBeDefined();
        expect(JSON.parse(data!.slice(6)).nationalTotal).toBe(expected);
      } finally { controller.abort(); }
    }
    expect((await getPool().query('SELECT count(*)::text AS count FROM presences WHERE event_id=$1', [test])).rows[0]?.count).toBe('1');
    expect((await getPool().query('SELECT count(*)::text AS count FROM presences WHERE event_id=$1', [real])).rows[0]?.count).toBe('2');
  });
});
