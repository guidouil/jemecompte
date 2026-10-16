import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db/index';
import { changeEventStatus, importEventConfiguration } from '../../src/lib/server/db/admin';
import { getCounterSnapshot, getNationalTotal } from '../../src/lib/server/counters';
import { getEventById, getEventBySlug, listPublicEvents } from '../../src/lib/server/events';
import { getPresenceStatus, registerPresence } from '../../src/lib/server/participation';
import { purgeEvent, reconcileEvent } from '../../src/lib/server/privacy';
import type { ParticipationPayload } from '../../src/lib/shared/types';

const testUrl = process.env.TEST_DATABASE_URL;
// Never infer a test connection from DATABASE_URL, and never truncate application tables.
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test.');
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousApproval = process.env.REAL_EVENTS_APPROVED;
const fixtureIds: string[] = [];
const actor = { operator: 'integration-test', reason: 'Synthetic isolated integration fixture' };
const polygon = { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]]] };
const payload = (): ParticipationPayload => ({ anonymousEventId: randomBytes(32).toString('base64url'), geofenceVersion: 1, protocolVersion: 1, insideZone: true });

async function fixture(options: { isTest?: boolean; city?: string; endsAgoHours?: number; startsInHours?: number; draft?: boolean } = {}) {
  const id = randomUUID();
  fixtureIds.push(id);
  const end = options.endsAgoHours ? Date.now() - options.endsAgoHours * 3_600_000 : Date.now() + 3_600_000;
  const start = options.startsInHours ? Date.now() + options.startsInHours * 3_600_000 : Math.min(Date.now() - 3_600_000, end - 3_600_000);
  await getPool().query(`INSERT INTO events
    (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
    VALUES ($1,$2,'Événement fictif intégration',$3,'Ville fictive',$4::jsonb,$5,$6,$7,$8)`,
  [id, `integration-${id}`, options.city ?? id.slice(0, 8), JSON.stringify(polygon), new Date(start),
    options.startsInHours ? new Date(start + 3_600_000) : new Date(end), options.draft ? 'draft' : 'published', options.isTest ?? true]);
  return id;
}

describe.skipIf(!testUrl)('PostgreSQL participation and aggregate guarantees', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.REAL_EVENTS_APPROVED = 'false';
    await closeDatabase();
    await migrate();
    await migrate(); // An applied migration is safely recognized and checksum-verified.
  });
  afterEach(async () => {
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
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousApproval === undefined) delete process.env.REAL_EVENTS_APPROVED;
    else process.env.REAL_EVENTS_APPROVED = previousApproval;
  });

  it('accepts one of 100 concurrent identical submissions and exactly counts distinct identifiers', async () => {
    const id = await fixture();
    const same = payload();
    const replies = await Promise.all(Array.from({ length: 100 }, () => registerPresence(id, same)));
    expect(replies.filter((reply) => reply.status === 'counted')).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 'already_counted')).toHaveLength(99);
    const distinct = await Promise.all(Array.from({ length: 50 }, () => registerPresence(id, payload())));
    expect(distinct.every((reply) => reply.status === 'counted')).toBe(true);
    expect((await getCounterSnapshot(id))?.total).toBe('51');
    expect((await reconcileEvent(id)).status).toBe('consistent');
    const count = await getPool().query<{ total: string }>('SELECT count(*)::text AS total FROM presences WHERE event_id=$1', [id]);
    expect(count.rows[0]?.total).toBe('51');
  });

  it('recognizes a lost response after closure and an old geofence version without admitting anyone new', async () => {
    const id = await fixture();
    const original = payload();
    expect((await registerPresence(id, original)).status).toBe('counted');
    await changeEventStatus(id, 'close', actor);
    await getPool().query('UPDATE events SET geofence_version=2 WHERE id=$1', [id]);
    expect((await registerPresence(id, original)).status).toBe('already_counted');
    expect((await getPresenceStatus(id, original.anonymousEventId))?.status).toBe('counted');
    expect((await registerPresence(id, payload())).status).toBe('ended');
    expect((await getCounterSnapshot(id))?.total).toBe('1');
  });

  it('rolls the presence back if the counter write fails, then allows the same identifier to retry', async () => {
    const id = await fixture();
    const functionName = `reject_counter_${id.replaceAll('-', '')}`;
    const triggerName = `counter_failure_${id.replaceAll('-', '')}`;
    await getPool().query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic counter failure'; END $$`);
    await getPool().query(`CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE ON event_counters FOR EACH ROW WHEN (NEW.event_id='${id}'::uuid) EXECUTE FUNCTION ${functionName}()`);
    const request = payload();
    try {
      await expect(registerPresence(id, request)).rejects.toThrow();
      expect((await getPresenceStatus(id, request.anonymousEventId))?.status).toBe('not_counted');
      expect((await getCounterSnapshot(id))?.total).toBe('0');
    } finally {
      await getPool().query(`DROP TRIGGER ${triggerName} ON event_counters`);
      await getPool().query(`DROP FUNCTION ${functionName}()`);
    }
    expect((await registerPresence(id, request)).status).toBe('counted');
    expect((await getCounterSnapshot(id))?.total).toBe('1');
  });

  it('uses the real decision time after a lock wait instead of transaction-start time', async () => {
    const id = await fixture();
    const blocker = await getPool().connect();
    let pending: ReturnType<typeof registerPresence> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [id]);
      await blocker.query("UPDATE events SET ends_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1", [id]);
      pending = registerPresence(id, payload());
      await new Promise((resolve) => setTimeout(resolve, 350));
      await blocker.query('COMMIT');
      expect((await pending).status).toBe('ended');
      expect((await getCounterSnapshot(id))?.total).toBe('0');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });

  it('respects pause and the exclusive closing boundary, version changes and future opening', async () => {
    const id = await fixture();
    await changeEventStatus(id, 'pause', actor);
    expect((await registerPresence(id, payload())).status).toBe('paused');
    await changeEventStatus(id, 'publish', actor);
    expect((await registerPresence(id, { ...payload(), geofenceVersion: 2 })).status).toBe('event_updated');
    const future = await fixture({ startsInHours: 1 });
    expect((await registerPresence(future, payload())).status).toBe('not_open');
    const ended = await fixture({ endsAgoHours: 1 });
    expect((await registerPresence(ended, payload())).status).toBe('ended');
  });

  it('keeps real-event admissions and publication disabled by default', async () => {
    const real = await fixture({ isTest: false });
    expect((await registerPresence(real, payload())).status).toBe('real_events_disabled');
    const draft = await fixture({ isTest: false, draft: true });
    await expect(changeEventStatus(draft, 'publish', actor)).rejects.toThrow('disabled');
    expect(await getEventById(draft)).toBeNull();
    process.env.REAL_EVENTS_APPROVED = 'true';
    expect((await registerPresence(real, payload())).status).toBe('counted');
  });

  it('isolates test and real totals, preserves bigint precision and reports French counting days', async () => {
    const test = await fixture({ city: 'synthetic-city' });
    const real = await fixture({ isTest: false, city: 'synthetic-city' });
    const beforeTest = BigInt(await getNationalTotal(true));
    const beforeReal = BigInt(await getNationalTotal(false));
    await registerPresence(test, payload());
    process.env.REAL_EVENTS_APPROVED = 'true';
    await registerPresence(real, payload());
    expect(BigInt(await getNationalTotal(true))).toBe(beforeTest + 1n);
    expect(BigInt(await getNationalTotal(false))).toBe(beforeReal + 1n);
    const precise = '9007199254740993';
    await getPool().query('UPDATE event_counters SET count=$2::bigint,revision=$2::bigint WHERE event_id=$1', [test, precise]);
    expect((await getCounterSnapshot(test))?.total).toBe(precise);
    const day = await getPool().query<{ day: string }>("SELECT (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS day");
    expect((await getCounterSnapshot(test))?.day).toBe(day.rows[0]?.day);
    const clockCases = await getPool().query<{ day: string }>(`
      SELECT (instant AT TIME ZONE 'Europe/Paris')::date::text AS day FROM
      (VALUES ('2026-03-28T23:30:00Z'::timestamptz),('2026-10-24T22:30:00Z'::timestamptz)) cases(instant)`);
    expect(clockCases.rows.map((row) => row.day)).toEqual(['2026-03-29', '2026-10-25']);
  });

  it('purges atomically at deadline, retains totals, expires status and prevents reopening', async () => {
    const id = await fixture();
    const original = payload();
    await registerPresence(id, original);
    await expect(purgeEvent(id, actor)).rejects.toThrow('deadline');
    await changeEventStatus(id, 'close', actor);
    await getPool().query("UPDATE events SET starts_at=clock_timestamp()-interval '100 hours', ends_at=clock_timestamp()-interval '72 hours' WHERE id=$1", [id]);
    expect(await purgeEvent(id, actor)).toBe('purged');
    expect(await purgeEvent(id, actor)).toBe('already_purged');
    expect((await getPresenceStatus(id, original.anonymousEventId))?.status).toBe('details_expired');
    expect((await getCounterSnapshot(id))?.total).toBe('1');
    expect((await reconcileEvent(id)).status).toBe('details_expired');
    const remaining = await getPool().query<{ total: string }>('SELECT count(*)::text AS total FROM presences WHERE event_id=$1', [id]);
    expect(remaining.rows[0]?.total).toBe('0');
    expect((await registerPresence(id, original)).status).toBe('ended');
    await expect(changeEventStatus(id, 'publish', actor)).rejects.toThrow('cannot be reopened');
  });

  it('keeps one presence across midnight while counting only new admissions in the current national day', async () => {
    const id = await fixture();
    const previous = payload();
    const baseline = BigInt(await getNationalTotal(true));
    await getPool().query("UPDATE events SET starts_at=clock_timestamp()-interval '48 hours' WHERE id=$1", [id]);
    await getPool().query(`INSERT INTO presences (event_id,anonymous_event_id,counting_day)
      VALUES ($1,$2,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date-1)`,
    [id, Buffer.from(previous.anonymousEventId, 'base64url')]);
    await getPool().query(`INSERT INTO event_counters (event_id,counting_day,count,revision)
      VALUES ($1,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date-1,1,1)`, [id]);
    expect((await registerPresence(id, previous)).status).toBe('already_counted');
    expect(BigInt(await getNationalTotal(true))).toBe(baseline);
    expect((await registerPresence(id, payload())).status).toBe('counted');
    expect((await getCounterSnapshot(id))?.total).toBe('2');
    expect(BigInt(await getNationalTotal(true))).toBe(baseline + 1n);
    expect((await reconcileEvent(id)).status).toBe('consistent');
  });

  it('detects a mismatch and refuses finalization/purge rather than repairing the number', async () => {
    const id = await fixture({ endsAgoHours: 72 });
    await getPool().query("INSERT INTO event_counters (event_id,counting_day,count,revision) VALUES ($1,current_date,7,7)", [id]);
    expect((await reconcileEvent(id)).status).toBe('mismatch');
    await expect(reconcileEvent(id, { finalize: true, actor })).rejects.toThrow('inconsistent');
    await expect(purgeEvent(id, actor)).rejects.toThrow('mismatch');
    expect((await getCounterSnapshot(id))?.total).toBe('7');
  });

  it('validates imports, requires separate publication and exposes only public events', async () => {
    const id = randomUUID();
    fixtureIds.push(id);
    const config = {
      id, slug: `import-${id}`, name: 'Import fictif', cityCode: '75056', cityName: 'Paris', geofence: polygon,
      startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), isTest: true
    };
    expect(await importEventConfiguration(config, actor)).toBe(id);
    expect(await getEventBySlug(config.slug)).toBeNull();
    await changeEventStatus(id, 'publish', actor);
    expect((await getEventBySlug(config.slug))?.isTest).toBe(true);
    expect((await listPublicEvents()).some((event) => event.id === id)).toBe(true);
    await expect(importEventConfiguration({ ...config, cityCode: 'changed' }, actor)).rejects.toThrow('Only drafts');
    await expect(importEventConfiguration({ ...config, coordinates: [2.3, 48.8] }, actor)).rejects.toThrow();
    const columns = await getPool().query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='presences' ORDER BY ordinal_position");
    expect(columns.rows.map((row) => row.column_name)).toEqual(['event_id', 'anonymous_event_id', 'counting_day']);
  });

  it('allows admission SQL under the restricted role while denying event configuration, audit, deletion and DDL', async () => {
    const id = await fixture({ draft: true });
    const roleName = `jemecompte_role_${randomUUID().replaceAll('-', '')}`;
    const client = await getPool().connect();
    try {
      // PostgreSQL roles/grants are transactional. This private role and every write roll back;
      // concurrent E2E sessions never adopt it and no shared application role is modified.
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${roleName} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
      await client.query(`GRANT SELECT ON events TO ${roleName}`);
      await client.query(`GRANT UPDATE (updated_at) ON events TO ${roleName}`);
      await client.query(`GRANT SELECT, INSERT ON presences TO ${roleName}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE ON event_counters TO ${roleName}`);
      await client.query(`SET LOCAL ROLE ${roleName}`);
      const locked = await client.query('SELECT * FROM events WHERE id=$1 FOR SHARE', [id]);
      expect(locked.rowCount).toBe(1);
      const opaque = randomBytes(32);
      await client.query(`INSERT INTO presences(event_id,anonymous_event_id,counting_day)
        VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date)
        ON CONFLICT(event_id,anonymous_event_id) DO NOTHING RETURNING event_id`, [id, opaque]);
      const upsert = `INSERT INTO event_counters(event_id,counting_day,count,revision)
        VALUES($1,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date,1,1)
        ON CONFLICT(event_id,counting_day) DO UPDATE
        SET count=event_counters.count+1, revision=event_counters.revision+1`;
      await client.query(upsert, [id]);
      await client.query(upsert, [id]); // Exercise UPDATE privileges too, then roll everything back.
      const counter = await client.query<{ count: string }>('SELECT count::text FROM event_counters WHERE event_id=$1', [id]);
      expect(counter.rows[0]?.count).toBe('2');
      const denied = [
        "UPDATE events SET status='closed' WHERE id=$1",
        "UPDATE events SET geofence_version=2 WHERE id=$1",
        'DELETE FROM presences WHERE event_id=$1',
        "INSERT INTO admin_audit(event_id,operator,action,reason) VALUES($1,'test','forbidden','test')",
        'ALTER TABLE events ADD COLUMN forbidden_test_column text'
      ];
      for (const statement of denied) {
        await client.query('SAVEPOINT privilege_check');
        await expect(client.query(statement, statement.includes('$1') ? [id] : [])).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT privilege_check');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
