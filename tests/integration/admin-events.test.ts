import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { closeDatabase, getPool } from '../../src/lib/server/db';
import { deleteAdminEvent, listAdminEvents } from '../../src/lib/server/admin-events';
import { registerPresence } from '../../src/lib/server/participation';
import { getNationalTotal } from '../../src/lib/server/counters';
import { publicCounterSnapshot, publicNationalTotal } from '../../src/lib/server/public-data';
import { counterStream } from '../../src/lib/server/realtime';
import { purgeEvent, reconcileEvent } from '../../src/lib/server/privacy';
import { mergeCounterSnapshots } from '../../src/lib/client/counter-snapshot';
import type { CounterSnapshot, CountingScope, EventStatus } from '../../src/lib/shared/types';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) throw new Error('Admin deletion tests require a dedicated TEST_DATABASE_URL ending in _test.');
const previousDatabase = process.env.DATABASE_URL;
const previousAdminDatabase = process.env.ADMIN_DATABASE_URL;
const previousApproval = process.env.REAL_EVENTS_APPROVED;
const tag = `admin-events-${randomUUID()}`;
const actor = { operator: tag, reason: 'Recette fictive de suppression en base dédiée' };
const ids: string[] = [];
const controllers: AbortController[] = [];
const polygon = { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.86]]] };

async function fixture(options: { isTest?: boolean; scope?: CountingScope; status?: EventStatus; endedHoursAgo?: number } = {}) {
  const id = randomUUID(); ids.push(id);
  const slug = `${tag}-${id}`;
  const endsAt = new Date(Date.now() + (options.endedHoursAgo ? -options.endedHoursAgo : 1) * 3_600_000);
  const startsAt = new Date(endsAt.getTime() - 7_200_000);
  await getPool().query(`INSERT INTO events(id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test,counting_scope)
    VALUES($1,$2,$3,$4,$3,$5::jsonb,$6,$7,$8,$9,$10)`, [
    id, slug, tag, `T${tag.slice(-8)}`, JSON.stringify(polygon), startsAt, endsAt,
    options.status ?? 'published', options.isTest ?? false, options.scope ?? 'gathering'
  ]);
  await getPool().query(`INSERT INTO admin_audit(event_id,operator,action,reason,configuration)
    VALUES($1,$2,'import_draft',$3,$4::jsonb)`, [id, actor.operator, actor.reason, JSON.stringify({ slug })]);
  return { id, slug };
}

async function remaining(id: string) {
  return (await getPool().query(`SELECT
    (SELECT count(*)::text FROM events WHERE id=$1) AS events,
    (SELECT count(*)::text FROM presences WHERE event_id=$1) AS presences,
    (SELECT count(*)::text FROM event_counters WHERE event_id=$1) AS counters,
    (SELECT count(*)::text FROM admin_audit WHERE event_id=$1) AS audits`, [id])).rows[0];
}

describe.skipIf(!testUrl)('private event deletion on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.ADMIN_DATABASE_URL = testUrl;
    process.env.REAL_EVENTS_APPROVED = 'true';
    await closeDatabase();
    await migrate();
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    for (const table of ['admin_audit', 'presences', 'event_counters'] as const) {
      await getPool().query(`DELETE FROM ${table} WHERE event_id=ANY($1::uuid[])`, [ids]);
    }
    await getPool().query('DELETE FROM admin_audit WHERE operator=$1', [actor.operator]);
    await getPool().query('DELETE FROM events WHERE id=ANY($1::uuid[])', [ids.splice(0)]);
  });
  afterAll(async () => {
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousAdminDatabase === undefined) delete process.env.ADMIN_DATABASE_URL; else process.env.ADMIN_DATABASE_URL = previousAdminDatabase;
    if (previousApproval === undefined) delete process.env.REAL_EVENTS_APPROVED; else process.env.REAL_EVENTS_APPROVED = previousApproval;
  });

  it('lists all modes, scopes and statuses in pages without returning geometry or participant IDs', async () => {
    const statuses: EventStatus[] = ['draft', 'published', 'paused', 'closed', 'cancelled'];
    for (let index = 0; index < 43; index++) {
      await fixture({ isTest: index % 2 === 0, scope: index % 3 === 0 ? 'city' : 'gathering', status: statuses[index % statuses.length] });
    }
    const first = await listAdminEvents({ q: tag.toUpperCase() });
    const second = await listAdminEvents({ q: tag, page: 2 });
    expect(first).toMatchObject({ page: 1, pageSize: 40, hasNext: true });
    expect(second).toMatchObject({ page: 2, pageSize: 40, hasNext: false });
    expect(first.events).toHaveLength(40);
    expect(second.events).toHaveLength(3);
    const all = [...first.events, ...second.events];
    expect(new Set(all.map((event) => event.id)).size).toBe(43);
    expect(new Set(all.map((event) => event.status))).toEqual(new Set(statuses));
    expect(new Set(all.map((event) => event.isTest))).toEqual(new Set([true, false]));
    expect(new Set(all.map((event) => event.countingScope))).toEqual(new Set(['gathering', 'city']));
    expect(Object.keys(all[0]!).sort()).toEqual([
      'id', 'slug', 'name', 'cityName', 'startsAt', 'endsAt', 'status', 'isTest', 'countingScope', 'totalCount', 'retainedPresences'
    ].sort());
    expect((await listAdminEvents({ q: `${tag}%' OR true --` })).events).toEqual([]);
  });

  it('requires exact confirmation and removes the event from live aggregates, caches and streams with a detached minimal audit', async () => {
    const target = await fixture({ scope: 'city' });
    const survivor = await fixture({ scope: 'city' });
    const identity = randomBytes(32).toString('base64url');
    for (const anonymousEventId of [identity, randomBytes(32).toString('base64url')]) {
      expect((await registerPresence(target.id, { anonymousEventId, geofenceVersion: 1, protocolVersion: 1, insideZone: true, countingScope: 'city' })).status).toBe('counted');
    }
    const before = BigInt(await getNationalTotal(false, 'city'));
    await publicNationalTotal('city');
    expect((await publicCounterSnapshot(target.id))?.total).toBe('2');
    const survivorBefore = (await publicCounterSnapshot(survivor.id))!;
    expect(survivorBefore.nationalTotal).toBe(String(before));
    const controller = new AbortController(); controllers.push(controller);
    const response = await counterStream(target.id, controller.signal);
    const reader = response!.body!.getReader();
    await reader.read();
    const survivorController = new AbortController(); controllers.push(survivorController);
    const survivorResponse = await counterStream(survivor.id, survivorController.signal);
    const survivorReader = survivorResponse!.body!.getReader();
    await survivorReader.read();
    expect(await deleteAdminEvent(target.id, ` ${target.slug}`, actor)).toEqual({ status: 'confirmation_mismatch' });
    expect(await remaining(target.id)).toEqual({ events: '1', presences: '2', counters: '1', audits: '1' });
    expect(await deleteAdminEvent(target.id, target.slug, actor)).toEqual({
      status: 'deleted', eventId: target.id, slug: target.slug, removedCount: '2', deletedPresences: '2', deletedCounterRows: 1, detachedAuditRows: 1
    });
    expect(await remaining(target.id)).toEqual({ events: '0', presences: '0', counters: '0', audits: '0' });
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(await publicCounterSnapshot(target.id)).toBeNull();
    expect(await publicNationalTotal('city')).toBe(String(before - 2n));
    expect((await publicCounterSnapshot(survivor.id))?.nationalTotal).toBe(String(before - 2n));
    const nextFrame = new TextDecoder().decode((await survivorReader.read()).value);
    const data = nextFrame.split('\n').find((line) => line.startsWith('data: '))!;
    const survivorAfter = JSON.parse(data.slice(6)) as CounterSnapshot;
    expect(survivorAfter.nationalTotal).toBe(String(before - 2n));
    expect(mergeCounterSnapshots(survivorBefore, survivorAfter).nationalTotal).toBe(String(before - 2n));
    expect((await remaining(survivor.id)).events).toBe('1');
    const audit = (await getPool().query("SELECT event_id,configuration FROM admin_audit WHERE operator=$1 AND action='delete_event'", [actor.operator])).rows[0];
    expect(audit.event_id).toBeNull();
    expect(audit.configuration).toEqual({ deletedEventId: target.id, slug: target.slug, removedCount: '2', deletedPresences: '2', deletedCounterRows: 1 });
    expect(JSON.stringify(audit)).not.toContain(identity);
    expect(await deleteAdminEvent(target.id, target.slug, actor)).toEqual({ status: 'not_found' });
  });

  it('lists and deletes retained totals even when individual presences have already expired', async () => {
    const target = await fixture({ status: 'closed', endedHoursAgo: 72, isTest: true });
    await getPool().query(`UPDATE events SET presences_purged_at=clock_timestamp(),finalized_at=clock_timestamp() WHERE id=$1`, [target.id]);
    await getPool().query("INSERT INTO event_counters(event_id,counting_day,count,revision) VALUES($1,'2026-10-17',42,42)", [target.id]);
    expect((await listAdminEvents({ q: target.slug })).events[0]).toMatchObject({ totalCount: '42', retainedPresences: '0', isTest: true });
    expect(await deleteAdminEvent(target.id, target.slug, actor)).toMatchObject({ status: 'deleted', removedCount: '42', deletedPresences: '0', deletedCounterRows: 1 });
    expect(await remaining(target.id)).toEqual({ events: '0', presences: '0', counters: '0', audits: '0' });
  });

  it('rolls all deletion and audit detachment back if recording the final audit fails', async () => {
    const target = await fixture();
    await getPool().query(`INSERT INTO presences(event_id,anonymous_event_id,counting_day)
      VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date)`, [target.id, randomBytes(32)]);
    await getPool().query(`INSERT INTO event_counters(event_id,counting_day,count,revision)
      VALUES($1,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date,1,1)`, [target.id]);
    const functionName = `admin_fail_${randomUUID().replaceAll('-', '')}`;
    const triggerName = `${functionName}_t`;
    await getPool().query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operator = '${actor.operator}' AND NEW.action = 'delete_event' THEN
          RAISE EXCEPTION 'Synthetic deletion audit failure';
        END IF;
        RETURN NEW;
      END; $$`);
    try {
      await getPool().query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(deleteAdminEvent(target.id, target.slug, actor)).rejects.toThrow();
      expect(await remaining(target.id)).toEqual({ events: '1', presences: '1', counters: '1', audits: '1' });
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS ${triggerName} ON admin_audit`);
      await getPool().query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it('waits for an earlier admission transaction and removes its committed count as well', async () => {
    const target = await fixture();
    const client = await getPool().connect();
    let open = false;
    try {
      await client.query('BEGIN'); open = true;
      await client.query('SELECT id FROM events WHERE id=$1 FOR SHARE', [target.id]);
      await client.query(`INSERT INTO presences(event_id,anonymous_event_id,counting_day)
        VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date)`, [target.id, randomBytes(32)]);
      await client.query(`INSERT INTO event_counters(event_id,counting_day,count,revision)
        VALUES($1,(clock_timestamp() AT TIME ZONE 'Europe/Paris')::date,1,1)`, [target.id]);
      let settled = false;
      const deletion = deleteAdminEvent(target.id, target.slug, actor).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
      await client.query('COMMIT'); open = false;
      expect(await deletion).toMatchObject({ status: 'deleted', removedCount: '1', deletedPresences: '1' });
      expect(await remaining(target.id)).toEqual({ events: '0', presences: '0', counters: '0', audits: '0' });
    } finally {
      if (open) await client.query('ROLLBACK');
      client.release();
    }
  });

  it('serializes against reconciliation and retention purge without orphaned references', async () => {
    const target = await fixture({ status: 'closed', endedHoursAgo: 72 });
    await getPool().query(`INSERT INTO presences(event_id,anonymous_event_id,counting_day)
      SELECT id,$2,(ends_at AT TIME ZONE 'Europe/Paris')::date FROM events WHERE id=$1`, [target.id, randomBytes(32)]);
    await getPool().query(`INSERT INTO event_counters(event_id,counting_day,count,revision)
      SELECT id,(ends_at AT TIME ZONE 'Europe/Paris')::date,1,1 FROM events WHERE id=$1`, [target.id]);
    const [deletion] = await Promise.allSettled([
      deleteAdminEvent(target.id, target.slug, actor), reconcileEvent(target.id), purgeEvent(target.id, actor)
    ]);
    expect(deletion.status).toBe('fulfilled');
    if (deletion.status === 'fulfilled') expect(deletion.value).toMatchObject({ status: 'deleted', removedCount: '1' });
    expect(await remaining(target.id)).toEqual({ events: '0', presences: '0', counters: '0', audits: '0' });
  });
});
