import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db';
import { getCounterSnapshot, getNationalSupportTotal, getNationalTotals, readCounterSnapshot } from '../../src/lib/server/counters';
import { getSupportStatus, registerPresence, registerSupport } from '../../src/lib/server/participation';
import { purgeEvent, purgeExpiredDailySupportClaims, reconcileEvent } from '../../src/lib/server/privacy';
import { deleteAdminEvent } from '../../src/lib/server/admin-events';
import type { CountingScope, SupportPayload } from '../../src/lib/shared/types';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('Support tests require a dedicated TEST_DATABASE_URL ending in _test.');
const previousDatabase = process.env.DATABASE_URL;
const previousAdminDatabase = process.env.ADMIN_DATABASE_URL;
const previousApproval = process.env.REAL_EVENTS_APPROVED;
const ids: string[] = [];
const dailyTokens: Buffer[] = [];
const actor = { operator: `support-tests-${randomUUID()}`, reason: 'Synthetic anonymous support integration fixture' };
const polygon = { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]]] };
let today: string;

function token(): string { return randomBytes(32).toString('base64url'); }
function payload(options: Partial<SupportPayload> = {}): SupportPayload {
  const request = { anonymousEventId: token(), anonymousDayId: token(), day: today, protocolVersion: 1 as const, ...options };
  dailyTokens.push(Buffer.from(request.anonymousDayId, 'base64url'));
  return request;
}
function presence(request: SupportPayload) {
  return { anonymousEventId: request.anonymousEventId, protocolVersion: 1 as const, geofenceVersion: 1,
    insideZone: true as const, ...(request.countingScope ? { countingScope: request.countingScope } : {}) };
}
async function fixture(options: { isTest?: boolean; scope?: CountingScope; status?: string; startsInHours?: number } = {}) {
  const id = randomUUID(); ids.push(id);
  const start = Date.now() + (options.startsInHours ?? -1) * 3_600_000;
  await getPool().query(`INSERT INTO events(id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test,counting_scope)
    VALUES($1,$2,'Soutiens fictifs',$3,'Ville fictive',$4::jsonb,$5,$6,$7,$8,$9)`, [
    id, `support-${id}`, actor.operator.slice(-15), JSON.stringify(polygon), new Date(start),
    new Date(start + 7_200_000), options.status ?? 'published', options.isTest ?? true, options.scope ?? 'gathering'
  ]);
  return id;
}
async function counts(id: string) {
  return (await getPool().query(`SELECT
    (SELECT count(*)::text FROM supports WHERE event_id=$1) AS supports,
    (SELECT count(*)::text FROM presences WHERE event_id=$1) AS presences`, [id])).rows[0];
}

describe.skipIf(!testUrl)('anonymous remote supports on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.ADMIN_DATABASE_URL = testUrl;
    process.env.REAL_EVENTS_APPROVED = 'false';
    await closeDatabase();
    await migrate();
  });
  beforeEach(async () => {
    process.env.REAL_EVENTS_APPROVED = 'false';
    today = (await getPool().query<{ day: string }>("SELECT (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS day")).rows[0]!.day;
  });
  afterEach(async () => {
    for (const table of ['admin_audit', 'supports', 'support_counters', 'presences', 'event_counters']) {
      await getPool().query(`DELETE FROM ${table} WHERE event_id=ANY($1::uuid[])`, [ids]);
    }
    await getPool().query('DELETE FROM events WHERE id=ANY($1::uuid[])', [ids.splice(0)]);
    await getPool().query('DELETE FROM daily_support_claims WHERE anonymous_day_id=ANY($1::bytea[])', [dailyTokens.splice(0)]);
    await getPool().query('DELETE FROM admin_audit WHERE operator=$1', [actor.operator]);
  });
  afterAll(async () => {
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousAdminDatabase === undefined) delete process.env.ADMIN_DATABASE_URL; else process.env.ADMIN_DATABASE_URL = previousAdminDatabase;
    if (previousApproval === undefined) delete process.env.REAL_EVENTS_APPROVED; else process.env.REAL_EVENTS_APPROVED = previousApproval;
  });

  it('counts one concurrent support per event token and exposes separate aggregate totals', async () => {
    const id = await fixture(); const request = payload();
    expect((await getSupportStatus(id, request.anonymousEventId))?.status).toBe('not_supported');
    const replies = await Promise.all(Array.from({ length: 60 }, () => registerSupport(id, request)));
    expect(replies.filter((reply) => reply.status === 'supported')).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 'already_supported')).toHaveLength(59);
    const snapshot = await getCounterSnapshot(id);
    expect(snapshot).toMatchObject({ total: '0', revision: '0', supportTotal: '1', supportRevision: '1' });
    expect((await getSupportStatus(id, request.anonymousEventId))?.status).toBe('supported');
    expect(await counts(id)).toEqual({ supports: '1', presences: '0' });
    expect(await reconcileEvent(id)).toMatchObject({ status: 'consistent', total: '0', supportTotal: '1' });
  });

  it('allows a daily token to support only one event even during concurrent submissions', async () => {
    const daily = token();
    const targets = await Promise.all(Array.from({ length: 18 }, () => fixture()));
    const replies = await Promise.all(targets.map((id) => registerSupport(id, payload({ anonymousDayId: daily }))));
    expect(replies.filter((reply) => reply.status === 'supported')).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 'daily_limit_reached')).toHaveLength(17);
    expect((await getPool().query('SELECT 1 FROM daily_support_claims WHERE counting_day=$1 AND anonymous_day_id=$2', [today, Buffer.from(daily, 'base64url')])).rowCount).toBe(1);
    const snapshots = await Promise.all(targets.map((id) => getCounterSnapshot(id)));
    expect(snapshots.reduce((sum, snapshot) => sum + BigInt(snapshot!.supportTotal!), 0n)).toBe(1n);
  });

  it('replaces support with presence atomically and retains the daily limit after conversion', async () => {
    const id = await fixture(); const other = await fixture(); const request = payload();
    expect((await registerSupport(id, request)).status).toBe('supported');
    const before = await getNationalTotals();
    expect((await registerPresence(id, presence(request))).status).toBe('counted');
    const after = await getNationalTotals();
    expect(BigInt(after.total) + BigInt(after.supportTotal)).toBe(BigInt(before.total) + BigInt(before.supportTotal));
    expect(BigInt(after.total)).toBe(BigInt(before.total) + 1n);
    expect(BigInt(after.supportTotal)).toBe(BigInt(before.supportTotal) - 1n);
    expect(await getCounterSnapshot(id)).toMatchObject({ total: '1', revision: '1', supportTotal: '0', supportRevision: '2' });
    expect(await counts(id)).toEqual({ supports: '0', presences: '1' });
    expect((await getSupportStatus(id, request.anonymousEventId))?.status).toBe('present');
    expect((await registerSupport(id, request)).status).toBe('already_present');
    expect((await registerSupport(other, payload({ anonymousDayId: request.anonymousDayId }))).status).toBe('daily_limit_reached');
    expect((await reconcileEvent(id)).status).toBe('consistent');
  });

  it('serializes simultaneous support and presence so the same identity is never counted twice', async () => {
    const id = await fixture(); const request = payload();
    const replies = await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2
      ? registerPresence(id, presence(request)) : registerSupport(id, request)));
    expect(replies.filter((reply) => reply.status === 'counted')).toHaveLength(1);
    expect(await getCounterSnapshot(id)).toMatchObject({ total: '1', supportTotal: '0' });
    expect(await counts(id)).toEqual({ supports: '0', presences: '1' });
    expect((await reconcileEvent(id)).status).toBe('consistent');
  });

  it('never renews a multi-day event support and converts its original support day', async () => {
    const id = await fixture(); const request = payload();
    await getPool().query("UPDATE events SET starts_at=clock_timestamp()-interval '48 hours' WHERE id=$1", [id]);
    await getPool().query(`INSERT INTO supports(event_id,anonymous_event_id,counting_day)
      VALUES($1,$2,$3::date-1)`, [id, Buffer.from(request.anonymousEventId, 'base64url'), today]);
    await getPool().query('INSERT INTO support_counters(event_id,counting_day,count,revision) VALUES($1,$2::date-1,1,1)', [id, today]);
    const national = await getNationalSupportTotal();
    expect((await registerSupport(id, request)).status).toBe('already_supported');
    expect((await registerPresence(id, presence(request))).status).toBe('counted');
    expect(await getCounterSnapshot(id)).toMatchObject({ total: '1', supportTotal: '0', supportRevision: '2' });
    expect(await getNationalSupportTotal()).toBe(national);
    const oldCounter = await getPool().query('SELECT count::text,revision::text,counting_day=$2::date-1 AS yesterday FROM support_counters WHERE event_id=$1', [id, today]);
    expect(oldCounter.rows).toEqual([{ count: '0', revision: '2', yesterday: true }]);
    expect((await reconcileEvent(id)).status).toBe('consistent');
  });

  it('recognizes retries after closure and rejects new supports on paused, future, ended or hidden events', async () => {
    const id = await fixture(); const request = payload();
    await registerSupport(id, request);
    await getPool().query("UPDATE events SET status='closed' WHERE id=$1", [id]);
    expect((await registerSupport(id, request)).status).toBe('already_supported');
    expect((await getSupportStatus(id, request.anonymousEventId))?.status).toBe('supported');
    expect((await registerSupport(id, payload())).status).toBe('ended');
    expect((await registerSupport(await fixture({ status: 'paused' }), payload())).status).toBe('paused');
    expect((await registerSupport(await fixture({ startsInHours: 1 }), payload())).status).toBe('not_open');
    expect((await registerSupport(await fixture({ status: 'draft' }), payload())).status).toBe('not_found');
  });

  it('rejects stale Paris days and personal or geolocation fields without claiming the daily token', async () => {
    const id = await fixture(); const request = payload();
    expect((await registerSupport(id, { ...request, day: '2020-01-01' })).status).toBe('day_changed');
    for (const extra of [{ latitude: 48.86 }, { coordinates: [2.3, 48.8] }, { email: 'test@example.com' }, { day: '2026-02-30' }]) {
      expect((await registerSupport(id, { ...request, ...extra } as SupportPayload)).status).toBe('invalid_request');
    }
    expect((await registerSupport(id, request)).status).toBe('supported');
    expect(await getSupportStatus(id, 'invalid')).toBeNull();
  });

  it('keeps test/real and gathering/city totals separate and requires explicit city scope', async () => {
    const gathering = await fixture(); const city = await fixture({ scope: 'city' });
    const real = await fixture({ isTest: false });
    const baseline = await Promise.all([getNationalSupportTotal(true), getNationalSupportTotal(true, 'city'), getNationalSupportTotal(false)]);
    expect((await registerSupport(real, payload())).status).toBe('real_events_disabled');
    expect((await registerSupport(city, payload())).status).toBe('scope_confirmation_required');
    expect((await registerSupport(gathering, payload({ countingScope: 'city' }))).status).toBe('invalid_request');
    expect((await registerSupport(gathering, payload(), false)).status).toBe('not_found');
    expect((await registerSupport(gathering, payload())).status).toBe('supported');
    expect((await registerSupport(city, payload({ countingScope: 'city' }))).status).toBe('supported');
    process.env.REAL_EVENTS_APPROVED = 'true';
    expect((await registerSupport(real, payload())).status).toBe('supported');
    const after = await Promise.all([getNationalSupportTotal(true), getNationalSupportTotal(true, 'city'), getNationalSupportTotal(false)]);
    expect(after).toEqual(baseline.map((total) => (BigInt(total) + 1n).toString()));
    expect(await getCounterSnapshot(gathering)).toMatchObject({ citySupportTotal: '1' });
    expect(await getCounterSnapshot(city)).toMatchObject({ citySupportTotal: '1' });
    expect(await getSupportStatus(real, payload().anonymousEventId, true)).toBeNull();
    const precise = '9007199254740993';
    await getPool().query('UPDATE support_counters SET count=$2::bigint,revision=$2::bigint WHERE event_id=$1', [gathering, precise]);
    expect(await getCounterSnapshot(gathering)).toMatchObject({ supportTotal: precise, supportRevision: precise });
  });

  it('uses the decision clock after waiting for a daily claim and does not admit after event closure', async () => {
    const id = await fixture(); const request = payload();
    const blocker = await getPool().connect();
    let pending: ReturnType<typeof registerSupport> | undefined;
    try {
      await getPool().query("UPDATE events SET ends_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1", [id]);
      await blocker.query('BEGIN');
      await blocker.query('INSERT INTO daily_support_claims(counting_day,anonymous_day_id) VALUES($1,$2)', [today, Buffer.from(request.anonymousDayId, 'base64url')]);
      pending = registerSupport(id, request);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await blocker.query('COMMIT');
      expect((await pending).status).toBe('ended');
      expect(await getCounterSnapshot(id)).toMatchObject({ total: '0', supportTotal: '0' });
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await pending;
    }
  });

  it('rolls back support and daily claim if a counter wait passes the end boundary', async () => {
    const id = await fixture(); const request = payload();
    const name = `support_delay_${randomUUID().replaceAll('-', '')}`;
    await getPool().query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$`);
    try {
      await getPool().query(`CREATE TRIGGER ${name} BEFORE INSERT ON support_counters FOR EACH ROW WHEN (NEW.event_id='${id}'::uuid) EXECUTE FUNCTION ${name}()`);
      await getPool().query("UPDATE events SET ends_at=clock_timestamp()+interval '180 milliseconds' WHERE id=$1", [id]);
      expect((await registerSupport(id, request)).status).toBe('ended');
      expect(await counts(id)).toEqual({ supports: '0', presences: '0' });
      expect((await getPool().query('SELECT 1 FROM daily_support_claims WHERE anonymous_day_id=$1', [Buffer.from(request.anonymousDayId, 'base64url')])).rowCount).toBe(0);
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS ${name} ON support_counters`);
      await getPool().query(`DROP FUNCTION ${name}()`);
    }
  });

  it('rolls every admission write back on counter failure and allows a safe retry', async () => {
    const id = await fixture(); const request = payload();
    const name = `support_failure_${randomUUID().replaceAll('-', '')}`;
    await getPool().query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic support counter failure'; END $$`);
    try {
      await getPool().query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON support_counters FOR EACH ROW WHEN (NEW.event_id='${id}'::uuid) EXECUTE FUNCTION ${name}()`);
      await expect(registerSupport(id, request)).rejects.toThrow();
      expect((await getSupportStatus(id, request.anonymousEventId))?.status).toBe('not_supported');
      expect((await getPool().query('SELECT 1 FROM daily_support_claims WHERE anonymous_day_id=$1', [Buffer.from(request.anonymousDayId, 'base64url')])).rowCount).toBe(0);
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS ${name} ON support_counters`);
      await getPool().query(`DROP FUNCTION ${name}()`);
    }
    expect((await registerSupport(id, request)).status).toBe('supported');
  });

  it('restores an existing support if the presence counter fails during conversion', async () => {
    const id = await fixture(); const request = payload();
    await registerSupport(id, request);
    const name = `conversion_failure_${randomUUID().replaceAll('-', '')}`;
    await getPool().query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic presence counter failure'; END $$`);
    try {
      await getPool().query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON event_counters FOR EACH ROW WHEN (NEW.event_id='${id}'::uuid) EXECUTE FUNCTION ${name}()`);
      await expect(registerPresence(id, presence(request))).rejects.toThrow();
      expect(await getCounterSnapshot(id)).toMatchObject({ total: '0', supportTotal: '1', supportRevision: '1' });
      expect(await counts(id)).toEqual({ supports: '1', presences: '0' });
      expect((await getSupportStatus(id, request.anonymousEventId))?.status).toBe('supported');
      expect((await reconcileEvent(id)).status).toBe('consistent');
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS ${name} ON event_counters`);
      await getPool().query(`DROP FUNCTION ${name}()`);
    }
    expect((await registerPresence(id, presence(request))).status).toBe('counted');
    expect(await getCounterSnapshot(id)).toMatchObject({ total: '1', supportTotal: '0', supportRevision: '2' });
  });

  it('purges support identifiers with presences, retains totals, and detects support mismatches', async () => {
    const id = await fixture(); const request = payload();
    await registerSupport(id, request);
    await getPool().query("UPDATE events SET starts_at=clock_timestamp()-interval '100 hours',ends_at=clock_timestamp()-interval '72 hours',status='closed' WHERE id=$1", [id]);
    expect(await purgeEvent(id, actor)).toBe('purged');
    expect(await counts(id)).toEqual({ supports: '0', presences: '0' });
    expect((await getSupportStatus(id, request.anonymousEventId))?.status).toBe('details_expired');
    expect(await getCounterSnapshot(id)).toMatchObject({ supportTotal: '1' });
    expect(await reconcileEvent(id)).toMatchObject({ status: 'details_expired', supportTotal: '1' });
    const corrupt = await fixture();
    await getPool().query('INSERT INTO support_counters(event_id,counting_day,count,revision) VALUES($1,$2,7,7)', [corrupt, today]);
    await getPool().query("UPDATE events SET starts_at=clock_timestamp()-interval '100 hours',ends_at=clock_timestamp()-interval '72 hours',status='closed' WHERE id=$1", [corrupt]);
    expect(await reconcileEvent(corrupt)).toMatchObject({ status: 'mismatch', supportMismatchedDays: [today] });
    await expect(reconcileEvent(corrupt, { finalize: true, actor })).rejects.toThrow('inconsistent');
    await expect(purgeEvent(corrupt, actor)).rejects.toThrow('mismatch');
  });

  it('keeps daily claims unlinked and erases expired tokens on traffic or retention sweep', async () => {
    const columns = await getPool().query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='daily_support_claims' ORDER BY ordinal_position");
    expect(columns.rows.map((row) => row.column_name)).toEqual(['counting_day', 'anonymous_day_id']);
    const supportsColumns = await getPool().query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='supports' ORDER BY ordinal_position");
    expect(supportsColumns.rows.map((row) => row.column_name)).toEqual(['event_id', 'anonymous_event_id', 'counting_day']);
    const old = payload();
    await getPool().query('INSERT INTO daily_support_claims(counting_day,anonymous_day_id) VALUES($1::date-1,$2)', [today, Buffer.from(old.anonymousDayId, 'base64url')]);
    await registerSupport(await fixture(), payload());
    expect((await getPool().query('SELECT 1 FROM daily_support_claims WHERE anonymous_day_id=$1', [Buffer.from(old.anonymousDayId, 'base64url')])).rowCount).toBe(0);
    await getPool().query('INSERT INTO daily_support_claims(counting_day,anonymous_day_id) VALUES($1::date-1,$2)', [today, Buffer.from(old.anonymousDayId, 'base64url')]);
    expect(await purgeExpiredDailySupportClaims()).toBeGreaterThanOrEqual(1);
  });

  it('deletes event support rows and counters while retaining an unlinked daily claim and aggregate audit', async () => {
    const id = await fixture(); const request = payload();
    await registerSupport(id, request);
    const before = BigInt(await getNationalSupportTotal());
    expect(await deleteAdminEvent(id, `support-${id}`, actor)).toMatchObject({ status: 'deleted', removedCount: '0' });
    expect(await getCounterSnapshot(id)).toBeNull();
    expect(BigInt(await getNationalSupportTotal())).toBe(before - 1n);
    expect((await getPool().query('SELECT 1 FROM daily_support_claims WHERE anonymous_day_id=$1', [Buffer.from(request.anonymousDayId, 'base64url')])).rowCount).toBe(1);
    const audit = (await getPool().query("SELECT configuration FROM admin_audit WHERE operator=$1 AND action='delete_event'", [actor.operator])).rows[0]!.configuration;
    expect(audit).toMatchObject({ removedSupportCount: '1', deletedSupports: '1', deletedSupportCounterRows: 1 });
    expect(JSON.stringify(audit)).not.toContain(request.anonymousEventId);
    expect(JSON.stringify(audit)).not.toContain(request.anonymousDayId);
  });

  it('supports admissions and conversion SQL under restricted grants without event or audit administration', async () => {
    const id = await fixture(); const request = payload(); const role = `support_role_${randomUUID().replaceAll('-', '')}`;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT ON events TO ${role}`);
      await client.query(`GRANT UPDATE(updated_at) ON events TO ${role}`);
      await client.query(`GRANT SELECT,INSERT ON presences TO ${role}`);
      await client.query(`GRANT SELECT,INSERT,DELETE ON supports,daily_support_claims TO ${role}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE ON event_counters,support_counters TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query('SELECT id FROM events WHERE id=$1 FOR SHARE', [id]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${id}:${request.anonymousEventId}`]);
      await client.query('INSERT INTO daily_support_claims(counting_day,anonymous_day_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [today, Buffer.from(request.anonymousDayId, 'base64url')]);
      await client.query('INSERT INTO supports(event_id,anonymous_event_id,counting_day) VALUES($1,$2,$3)', [id, Buffer.from(request.anonymousEventId, 'base64url'), today]);
      await client.query('INSERT INTO support_counters(event_id,counting_day,count,revision) VALUES($1,$2,1,1)', [id, today]);
      expect((await readCounterSnapshot(client, id, Buffer.from(request.anonymousEventId, 'base64url')))?.supportExists).toBe(true);
      await client.query('DELETE FROM supports WHERE event_id=$1 AND anonymous_event_id=$2 RETURNING counting_day', [id, Buffer.from(request.anonymousEventId, 'base64url')]);
      await client.query('UPDATE support_counters SET count=count-1,revision=revision+1 WHERE event_id=$1', [id]);
      await client.query("DELETE FROM daily_support_claims WHERE counting_day < (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date");
      for (const statement of ["UPDATE events SET status='closed' WHERE id=$1", 'DELETE FROM presences WHERE event_id=$1', 'DELETE FROM support_counters WHERE event_id=$1', 'SELECT * FROM admin_audit', 'ALTER TABLE daily_support_claims ADD COLUMN forbidden text']) {
        await client.query('SAVEPOINT privilege_check');
        await expect(client.query(statement, statement.includes('$1') ? [id] : [])).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT privilege_check');
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
