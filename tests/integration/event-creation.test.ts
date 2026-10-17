import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db/index';
import { createPublicEvent } from '../../src/lib/server/event-creation';
import { getCounterSnapshot } from '../../src/lib/server/counters';
import { getEventById, listPublicEvents } from '../../src/lib/server/events';
import { publicCatalogue } from '../../src/lib/server/public-data';
import { registerPresence } from '../../src/lib/server/participation';
import { isInsideGeofence } from '../../src/lib/shared/geofence';
import type { CreateEventPayload } from '../../src/lib/shared/event-creation';
import { getPublicPlaceBoundary } from '../../src/lib/server/maps';

vi.mock('../../src/lib/server/maps', () => ({ getPublicPlaceBoundary: vi.fn() }));
const boundaryMock = vi.mocked(getPublicPlaceBoundary);
const officialBoundary = {
  code: '75056', name: 'Paris', center: [2.35, 48.85] as [number, number],
  geofence: { type: 'MultiPolygon' as const, coordinates: [
    [[[2.2, 48.8], [2.4, 48.8], [2.4, 48.9], [2.2, 48.9], [2.2, 48.8]]],
    [[[2.5, 48.8], [2.6, 48.8], [2.6, 48.9], [2.5, 48.9], [2.5, 48.8]]]
  ] }
};

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test.');
const previousDatabase = process.env.DATABASE_URL;
const previousApproval = process.env.REAL_EVENTS_APPROVED;
const fixtureIds: string[] = [];
function payload(): Exclude<CreateEventPayload, { countingScope: 'city' }> {
  const requestId = randomUUID();
  fixtureIds.push(requestId);
  return {
    requestId, name: 'Création communautaire fictive', cityCode: '75056', cityName: 'Paris',
    publicCenter: [2.36325,48.86735], radiusMeters: 200, durationMinutes: 120, publicLocationConfirmed: true
  };
}

describe.skipIf(!testUrl)('PostgreSQL public event creation', () => {
  beforeEach(() => { boundaryMock.mockReset(); boundaryMock.mockResolvedValue(officialBoundary); });
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.REAL_EVENTS_APPROVED = 'false';
    await closeDatabase();
    await migrate();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.REAL_EVENTS_APPROVED = 'false';
    for (const id of fixtureIds.splice(0)) {
      await getPool().query('DELETE FROM admin_audit WHERE event_id=$1', [id]);
      await getPool().query('DELETE FROM presences WHERE event_id=$1', [id]);
      await getPool().query('DELETE FROM event_counters WHERE event_id=$1', [id]);
      await getPool().query('DELETE FROM events WHERE id=$1', [id]);
    }
  });
  afterAll(async () => {
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousApproval === undefined) delete process.env.REAL_EVENTS_APPROVED; else process.env.REAL_EVENTS_APPROVED = previousApproval;
  });

  it('publishes an immediate bounded event with the supplied public name and zero presences or operator audit', async () => {
    const input = payload();
    const before = Date.now();
    const result = await createPublicEvent(input);
    expect(result.status).toBe('created');
    if (!('event' in result)) throw new Error(`Unexpected creation status: ${result.status}`);
    expect(result.event.isTest).toBe(true);
    expect(result.event.creationSource).toBe('community');
    expect(result.event.name).toBe(input.name);
    expect(result.event.status).toBe('published');
    expect(Date.parse(result.event.startsAt)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(result.event.endsAt) - Date.parse(result.event.startsAt)).toBe(120 * 60_000);
    expect(isInsideGeofence(...input.publicCenter, result.event.geofence)).toBe(true);
    expect((await getCounterSnapshot(input.requestId))?.total).toBe('0');
    const counts = await getPool().query<{ presences: string; audits: string }>(`
      SELECT (SELECT count(*) FROM presences WHERE event_id=$1)::text AS presences,
        (SELECT count(*) FROM admin_audit WHERE event_id=$1)::text AS audits`, [input.requestId]);
    expect(counts.rows[0]).toEqual({ presences: '0', audits: '0' });
  });

  it('persists the official whole-commune MultiPolygon and replays it without contacting the provider', async () => {
    const requestId = randomUUID();
    fixtureIds.push(requestId);
    const geofence = { type: 'MultiPolygon', coordinates: [
      [[[2.2, 48.8], [2.4, 48.8], [2.4, 48.9], [2.2, 48.9], [2.2, 48.8]]],
      [[[2.5, 48.8], [2.6, 48.8], [2.6, 48.9], [2.5, 48.9], [2.5, 48.8]]]
    ] };
    boundaryMock.mockResolvedValueOnce({ ...officialBoundary, geofence: { ...geofence, type: 'MultiPolygon' } });
    const input = {
      requestId, name: 'Comptage communal fictif', cityCode: '75056', cityName: 'Nom du navigateur',
      countingScope: 'city', durationMinutes: 240, publicLocationConfirmed: true
    };
    const result = await createPublicEvent(input);
    if (!('event' in result)) throw new Error(`Unexpected creation status: ${result.status}`);
    expect(result.status).toBe('created');
    expect(result.event).toMatchObject({ countingScope: 'city', cityCode: '75056', cityName: 'Paris', geofence });
    expect(isInsideGeofence(2.3, 48.85, result.event.geofence)).toBe(true);
    expect(isInsideGeofence(2.55, 48.85, result.event.geofence)).toBe(true);
    expect(isInsideGeofence(2.45, 48.85, result.event.geofence)).toBe(false);
    expect((await getCounterSnapshot(requestId))?.total).toBe('0');
    expect(boundaryMock).toHaveBeenCalledTimes(1);
    boundaryMock.mockClear();
    boundaryMock.mockRejectedValue(new Error('provider unavailable during replay'));
    expect(await createPublicEvent(input)).toEqual({ status: 'already_created', event: result.event });
    expect(boundaryMock).not.toHaveBeenCalled();
    expect(await createPublicEvent({ ...input, durationMinutes: 120 })).toEqual({ status: 'request_conflict' });
    expect(boundaryMock).not.toHaveBeenCalled();
  });

  it('uses the official gathering municipality and rejects a mismatching public center without inserting', async () => {
    const outside = { ...payload(), publicCenter: [2.45, 48.85] as [number, number] };
    expect(await createPublicEvent(outside)).toEqual({ status: 'invalid_location' });
    expect(await getEventById(outside.requestId)).toBeNull();
    const inside = { ...payload(), cityName: 'Nom arbitraire du navigateur' };
    const result = await createPublicEvent(inside);
    expect(result).toMatchObject({ status: 'created', event: { cityCode: '75056', cityName: 'Paris', countingScope: 'gathering' } });
    // Preserve existing public metadata on replay, including names from earlier releases.
    await getPool().query("UPDATE events SET city_name='Ancien nom déclaré' WHERE id=$1", [inside.requestId]);
    const stored = await getEventById(inside.requestId);
    boundaryMock.mockClear();
    boundaryMock.mockRejectedValue(new Error('provider unavailable during gathering replay'));
    expect(await createPublicEvent(inside)).toEqual({ status: 'already_created', event: stored });
    expect(boundaryMock).not.toHaveBeenCalled();
  });

  it.each([720, 1440, 2880, 4320] as const)('persists exactly %d real minutes and keeps a 72-hour replay immutable', async (durationMinutes) => {
    const input = { ...payload(), durationMinutes };
    const result = await createPublicEvent(input);
    expect(result.status).toBe('created');
    if (!('event' in result)) throw new Error(`Unexpected creation status: ${result.status}`);
    const start = Date.parse(result.event.startsAt);
    const end = Date.parse(result.event.endsAt);
    expect(end - start).toBe(durationMinutes * 60_000);
    const stored = await getEventById(input.requestId);
    expect(stored?.startsAt).toBe(result.event.startsAt);
    expect(stored?.endsAt).toBe(result.event.endsAt);
    if (durationMinutes === 4320) {
      const replay = await createPublicEvent(input);
      expect(replay.status).toBe('already_created');
      if (!('event' in replay)) throw new Error(`Unexpected replay status: ${replay.status}`);
      expect(replay.event.startsAt).toBe(result.event.startsAt);
      expect(replay.event.endsAt).toBe(result.event.endsAt);
      expect(await createPublicEvent({ ...input, durationMinutes: 2880 })).toEqual({ status: 'request_conflict' });
    }
  });

  it('deduplicates concurrent request IDs and rejects changed public payloads without rewriting the event', async () => {
    const input = payload();
    const results = await Promise.all(Array.from({ length: 30 }, () => createPublicEvent(input)));
    expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'already_created')).toHaveLength(29);
    const original = await getEventById(input.requestId);
    expect(await createPublicEvent({ ...input, radiusMeters: 500 })).toEqual({ status: 'request_conflict' });
    expect(await createPublicEvent({ ...input, name: 'Un autre nom' })).toEqual({ status: 'request_conflict' });
    expect(await getEventById(input.requestId)).toEqual(original);
  });

  it('stores a ten-kilometer geofence, includes nine kilometers, excludes eleven and keeps replays immutable', async () => {
    const input = { ...payload(), radiusMeters: 10_000 };
    const result = await createPublicEvent(input);
    expect(result.status).toBe('created');
    const stored = await getEventById(input.requestId);
    if (!stored) throw new Error('Created event was not persisted.');
    expect(isInsideGeofence(2.36325, 48.94829, stored.geofence)).toBe(true);
    expect(isInsideGeofence(2.36325, 48.966275, stored.geofence)).toBe(false);
    const replay = await createPublicEvent(input);
    expect(replay.status).toBe('already_created');
    if (!('event' in replay)) throw new Error(`Unexpected replay status: ${replay.status}`);
    expect(replay.event.geofence).toEqual(stored.geofence);
    expect(await createPublicEvent({ ...input, radiusMeters: 9999 })).toEqual({ status: 'request_conflict' });
    expect((await getCounterSnapshot(input.requestId))?.total).toBe('0');
  });

  it('keeps replay immutable when real-event configuration changes, and never treats an operator event as a public replay', async () => {
    const input = payload();
    const initial = await createPublicEvent(input);
    process.env.REAL_EVENTS_APPROVED = 'true';
    const replay = await createPublicEvent(input);
    expect(replay.status).toBe('already_created');
    if (!('event' in initial) || !('event' in replay)) throw new Error('Unexpected creation or replay failure.');
    expect(replay.event).toEqual(initial.event);
    const next = payload();
    const real = await createPublicEvent(next);
    if (!('event' in real)) throw new Error(`Unexpected creation status: ${real.status}`);
    expect(real.event.isTest).toBe(false);
    await getPool().query("UPDATE events SET creation_source='team',creation_request_hash=NULL WHERE id=$1", [input.requestId]);
    expect(await createPublicEvent(input)).toEqual({ status: 'request_conflict' });
  });

  it('invalidates a cached catalogue and prioritizes active and future events over historical entries', async () => {
    await publicCatalogue();
    const input = payload();
    await createPublicEvent(input);
    expect((await publicCatalogue()).some((event) => event.id === input.requestId)).toBe(true);
    const future = { ...payload(), startsAt: new Date(Date.now() + 60 * 86_400_000).toISOString() };
    const ended = payload();
    await createPublicEvent(future);
    await createPublicEvent(ended);
    await getPool().query("UPDATE events SET starts_at=clock_timestamp()-interval '2 hours',ends_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [ended.requestId]);
    const ids = (await listPublicEvents()).map((event) => event.id);
    expect(ids.indexOf(input.requestId)).toBeLessThan(ids.indexOf(future.requestId));
    expect(ids.indexOf(future.requestId)).toBeLessThan(ids.indexOf(ended.requestId));
    expect(ids).toContain(future.requestId);
    expect((await getCounterSnapshot(future.requestId))?.total).toBe('0');
    expect((await registerPresence(future.requestId, {
      anonymousEventId: randomBytes(32).toString('base64url'), geofenceVersion: 1, protocolVersion: 1, insideZone: true
    })).status).toBe('not_open');
    expect((await getCounterSnapshot(future.requestId))?.total).toBe('0');
  });

  it('persists an explicitly zoned future start and treats an equivalent UTC instant as the same request', async () => {
    const input = { ...payload(), durationMinutes: 240 as const, startsAt: '2100-07-15T15:30:00+02:00' };
    const result = await createPublicEvent(input);
    expect(result.status).toBe('created');
    if (!('event' in result)) throw new Error(`Unexpected creation status: ${result.status}`);
    expect(result.event.startsAt).toBe('2100-07-15T13:30:00.000Z');
    expect(result.event.endsAt).toBe('2100-07-15T17:30:00.000Z');
    const replay = await createPublicEvent({ ...input, startsAt: '2100-07-15T13:30:00.000Z' });
    expect(replay.status).toBe('already_created');
    if (!('event' in replay)) throw new Error(`Unexpected replay status: ${replay.status}`);
    expect(replay.event).toEqual(result.event);
    expect(await createPublicEvent({ ...input, startsAt: '2100-07-15T13:31:00Z' })).toEqual({ status: 'request_conflict' });
  });

  it('accepts a past start while its window remains open without creating retroactive presences', async () => {
    const clock = await getPool().query<{ instant: Date }>('SELECT clock_timestamp() AS instant');
    const startsAt = new Date(clock.rows[0]!.instant.getTime() - 3_600_000).toISOString();
    const input = { ...payload(), startsAt, durationMinutes: 240 as const };
    const result = await createPublicEvent(input);
    expect(result.status).toBe('created');
    if (!('event' in result)) throw new Error(`Unexpected creation status: ${result.status}`);
    expect(result.event.startsAt).toBe(startsAt);
    expect(Date.parse(result.event.endsAt) - Date.parse(startsAt)).toBe(4 * 3_600_000);
    expect((await getCounterSnapshot(input.requestId))?.total).toBe('0');
    const count = await getPool().query<{ count: string }>('SELECT count(*)::text AS count FROM presences WHERE event_id=$1', [input.requestId]);
    expect(count.rows[0]?.count).toBe('0');
  });

  it('rolls back a fully expired schedule including the closing boundary, leaving its request ID reusable', async () => {
    const clock = await getPool().query<{ instant: Date }>('SELECT clock_timestamp() AS instant');
    for (const extraPastMilliseconds of [0, 86_400_000]) {
      const input = { ...payload(), durationMinutes: 240 as const,
        startsAt: new Date(clock.rows[0]!.instant.getTime() - 4 * 3_600_000 - extraPastMilliseconds).toISOString() };
      expect(await createPublicEvent(input)).toEqual({ status: 'invalid_schedule' });
      expect(await getEventById(input.requestId)).toBeNull();
      expect(await getCounterSnapshot(input.requestId)).toBeNull();
      const retry = await createPublicEvent({ ...input, startsAt: undefined });
      expect(retry.status).toBe('created');
    }
  });

  it.each([
    ['2100-03-28T01:30:00+01:00', 240, '2100-03-28T04:30:00.000Z'],
    ['2100-10-31T01:30:00+02:00', 240, '2100-10-31T03:30:00.000Z'],
    ['2100-12-31T23:30:00+01:00', 4320, '2101-01-03T22:30:00.000Z']
  ] as const)('keeps real elapsed minutes across DST and calendar boundaries from %s', async (startsAt, durationMinutes, endsAt) => {
    const input = { ...payload(), startsAt, durationMinutes };
    const result = await createPublicEvent(input);
    expect(result.status).toBe('created');
    if (!('event' in result)) throw new Error(`Unexpected creation status: ${result.status}`);
    expect(result.event.endsAt).toBe(endsAt);
    expect(Date.parse(result.event.endsAt) - Date.parse(result.event.startsAt)).toBe(durationMinutes * 60_000);
    const stored = await getPool().query<{ minutes: string }>(
      'SELECT (EXTRACT(epoch FROM ends_at-starts_at)/60)::text AS minutes FROM events WHERE id=$1', [input.requestId]);
    expect(Number(stored.rows[0]?.minutes)).toBe(durationMinutes);
  });

  it('recognizes concurrent identical replays after the original explicit schedule has ended', async () => {
    const clock = await getPool().query<{ instant: Date }>('SELECT clock_timestamp() AS instant');
    const input = { ...payload(), durationMinutes: 60 as const,
      startsAt: new Date(clock.rows[0]!.instant.getTime() - 3_600_000 + 2_000).toISOString() };
    const initial = await createPublicEvent(input);
    expect(initial.status).toBe('created');
    if (!('event' in initial)) throw new Error(`Unexpected creation status: ${initial.status}`);
    await getPool().query("SELECT pg_sleep(GREATEST(0, EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))::double precision+0.05)", [initial.event.endsAt]);
    const replays = await Promise.all(Array.from({ length: 20 }, () => createPublicEvent(input)));
    expect(replays.every((reply) => reply.status === 'already_created')).toBe(true);
    expect(replays.every((reply) => 'event' in reply && reply.event.startsAt === initial.event.startsAt && reply.event.endsAt === initial.event.endsAt)).toBe(true);
    expect(await createPublicEvent({ ...input, startsAt: new Date(Date.parse(input.startsAt) - 1).toISOString() }))
      .toEqual({ status: 'request_conflict' });
    expect(await createPublicEvent({ ...input, requestId: payload().requestId })).toEqual({ status: 'invalid_schedule' });
  });

  it('rejects unconfirmed or private-field payloads before writing any event', async () => {
    const input = payload();
    await expect(createPublicEvent({ ...input, publicLocationConfirmed: false })).rejects.toThrow();
    await expect(createPublicEvent({ ...input, anonymousEventId: 'participant-private-value' })).rejects.toThrow();
    expect(await getEventById(input.requestId)).toBeNull();
  });

  it('requires only column-scoped event insertion in addition to the existing public role, without audit access', async () => {
    const input = payload();
    const role = `creation_role_${randomUUID().replaceAll('-', '')}`;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT, UPDATE(updated_at) ON events TO ${role}`);
      await client.query(`GRANT INSERT(id,slug,name,city_code,city_name,description,geofence,starts_at,ends_at,status,is_test,creation_source,creation_request_hash,counting_scope) ON events TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      const { rows } = await client.query<{ id: string; schedule_valid: boolean }>(`
        WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS instant)
        INSERT INTO events (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test,creation_source,creation_request_hash,counting_scope)
        SELECT $1,$2,'Création fictive','75056','Paris',$3::jsonb,
          COALESCE($5::timestamptz,instant),COALESCE($5::timestamptz,instant)+($6::integer*interval '1 minute'),
          'published',true,'community',$4,'city' FROM decision
        ON CONFLICT(id) DO NOTHING RETURNING *,ends_at>clock_timestamp() AS schedule_valid`, [input.requestId, `role-${input.requestId}`,
        JSON.stringify({ type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.86]]] }), Buffer.alloc(32, 1),
        '2100-01-01T12:00:00.000Z', 240]);
      expect(rows[0]?.id).toBe(input.requestId);
      expect(rows[0]?.schedule_valid).toBe(true);
      await client.query('SELECT * FROM events WHERE id=$1 FOR SHARE', [input.requestId]);
      await client.query('SAVEPOINT forbidden_admin');
      await expect(client.query("INSERT INTO admin_audit(event_id,operator,action,reason) VALUES($1,'forbidden','forbidden','forbidden')", [input.requestId]))
        .rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT forbidden_admin');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
