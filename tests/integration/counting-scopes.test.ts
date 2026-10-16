import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db';
import { changeEventStatus, importEventConfiguration } from '../../src/lib/server/db/admin';
import { getCounterSnapshot, getNationalTotal } from '../../src/lib/server/counters';
import { registerPresence } from '../../src/lib/server/participation';
import { publicCatalogue, publicNationalTotal } from '../../src/lib/server/public-data';
import { load } from '../../src/routes/+page.server';
import type { CountingScope, EventGeofence, ParticipationPayload } from '../../src/lib/shared/types';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required.');
const previousDatabase = process.env.DATABASE_URL;
const previousApproval = process.env.REAL_EVENTS_APPROVED;
const ids: string[] = [];
const actor = { operator: 'counting-scope-integration', reason: 'Synthetic counting-scope fixture in dedicated test database' };
const payload = (): ParticipationPayload => ({
  anonymousEventId: randomBytes(32).toString('base64url'), geofenceVersion: 1, protocolVersion: 1, insideZone: true
});

async function fixture(countingScope: CountingScope, isTest = true) {
  const id = randomUUID();
  ids.push(id);
  const ring = [[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]];
  const geofence: EventGeofence = countingScope === 'city'
    ? { type: 'MultiPolygon', coordinates: [[ring], [[[2.38,48.88],[2.39,48.88],[2.39,48.89],[2.38,48.89],[2.38,48.88]]]] }
    : { type: 'Polygon', coordinates: [ring] };
  await importEventConfiguration({
    id, slug: `scope-${id}`, name: 'Recette fictive de portée', cityCode: 'synthetic-scope-city', cityName: 'Ville fictive',
    isTest, countingScope, geofence,
    startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString()
  }, actor);
  await changeEventStatus(id, 'publish', actor);
  return id;
}

describe.skipIf(!testUrl)('city and gathering counter isolation on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.REAL_EVENTS_APPROVED = 'false';
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
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousApproval === undefined) delete process.env.REAL_EVENTS_APPROVED; else process.env.REAL_EVENTS_APPROVED = previousApproval;
  });

  it('keeps full-commune declarations separate from gathering totals, including a repeated identity', async () => {
    const gathering = await fixture('gathering');
    const city = await fixture('city');
    const previousGathering = BigInt(await getNationalTotal(true, 'gathering'));
    const previousCity = BigInt(await getNationalTotal(true, 'city'));
    const participant = payload();
    expect((await registerPresence(gathering, participant)).status).toBe('counted');
    expect((await registerPresence(city, { ...participant, countingScope: 'city' })).status).toBe('counted');
    expect((await registerPresence(city, { ...payload(), countingScope: 'city' })).status).toBe('counted');
    expect((await registerPresence(city, { ...participant, countingScope: 'city' })).status).toBe('already_counted');

    const gatheringSnapshot = await getCounterSnapshot(gathering);
    const citySnapshot = await getCounterSnapshot(city);
    expect(gatheringSnapshot).toMatchObject({ countingScope: 'gathering', total: '1', cityTotal: '1' });
    expect(citySnapshot).toMatchObject({ countingScope: 'city', total: '2', cityTotal: '2' });
    expect(gatheringSnapshot?.nationalTotal).toBe(String(previousGathering + 1n));
    expect(citySnapshot?.nationalTotal).toBe(String(previousCity + 2n));
    expect(await publicNationalTotal()).toBe(String(previousGathering + 1n));
    expect(await publicNationalTotal('city')).toBe(String(previousCity + 2n));
    const home = await load();
    expect(home.nationalTotal).toBe(String(previousGathering + 1n));
    expect(home.nationalCityTotal).toBe(String(previousCity + 2n));
    expect((await publicCatalogue()).find((event) => event.id === city)).toMatchObject({
      countingScope: 'city', geofence: { type: 'MultiPolygon' }
    });
  });

  it('keeps real city and test city totals separate as well', async () => {
    process.env.REAL_EVENTS_APPROVED = 'true';
    const realCity = await fixture('city', false);
    const beforeReal = BigInt(await getNationalTotal(false, 'city'));
    const beforeTest = await getNationalTotal(true, 'city');
    expect((await registerPresence(realCity, { ...payload(), countingScope: 'city' })).status).toBe('counted');
    expect(await getNationalTotal(false, 'city')).toBe(String(beforeReal + 1n));
    expect(await getNationalTotal(true, 'city')).toBe(beforeTest);
  });

  it('refuses a city admission from an old cached client without the explicit scope marker', async () => {
    const city = await fixture('city');
    const attempt = payload();
    expect((await registerPresence(city, attempt)).status).toBe('scope_confirmation_required');
    expect((await registerPresence(city, { ...attempt, countingScope: 'gathering' })).status).toBe('scope_confirmation_required');
    expect((await getCounterSnapshot(city))?.total).toBe('0');
    const gathering = await fixture('gathering');
    expect((await registerPresence(gathering, { ...attempt, countingScope: 'city' })).status).toBe('invalid_request');
    expect((await getCounterSnapshot(gathering))?.total).toBe('0');
  });
});
