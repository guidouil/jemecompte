import type { PoolClient } from 'pg';
import { getPool, isEventId, transaction } from './db';
import { audit, validateActor, type AdminActor } from './db/admin';
import type { EventRow } from './events';

export interface ReconciliationReport {
  eventId: string;
  status: 'consistent' | 'details_expired' | 'mismatch';
  total: string;
  supportTotal: string;
  mismatchedDays: string[];
  supportMismatchedDays: string[];
  finalized: boolean;
}

async function lockedEvent(client: PoolClient, eventId: string): Promise<EventRow> {
  if (!isEventId(eventId)) throw new Error('Invalid event UUID.');
  const { rows } = await client.query<EventRow>('SELECT * FROM events WHERE id=$1 FOR UPDATE', [eventId]);
  if (!rows[0]) throw new Error('Event not found.');
  return rows[0];
}

async function reconcileLocked(client: PoolClient, event: EventRow): Promise<ReconciliationReport> {
  const { rows } = await client.query<{ day: string; expected: string; actual: string }>(`
    WITH expected AS (SELECT counting_day, count(*) AS count FROM presences WHERE event_id=$1 GROUP BY counting_day),
    actual AS (SELECT counting_day, count FROM event_counters WHERE event_id=$1)
    SELECT COALESCE(e.counting_day,a.counting_day)::text AS day,
      COALESCE(e.count,0)::text AS expected, COALESCE(a.count,0)::text AS actual
    FROM expected e FULL JOIN actual a USING (counting_day) ORDER BY day`, [event.id]);
  const total = rows.reduce((sum, row) => sum + BigInt(row.actual), 0n).toString();
  const mismatchedDays = event.presences_purged_at ? [] : rows.filter((row) => row.expected !== row.actual).map((row) => row.day);
  const supports = await client.query<{ day: string; expected: string; actual: string }>(`
    WITH expected AS (SELECT counting_day, count(*) AS count FROM supports WHERE event_id=$1 GROUP BY counting_day),
    actual AS (SELECT counting_day, count FROM support_counters WHERE event_id=$1)
    SELECT COALESCE(e.counting_day,a.counting_day)::text AS day,
      COALESCE(e.count,0)::text AS expected, COALESCE(a.count,0)::text AS actual
    FROM expected e FULL JOIN actual a USING (counting_day) ORDER BY day`, [event.id]);
  const supportTotal = supports.rows.reduce((sum, row) => sum + BigInt(row.actual), 0n).toString();
  const supportMismatchedDays = event.presences_purged_at ? [] : supports.rows.filter((row) => row.expected !== row.actual).map((row) => row.day);
  return {
    eventId: event.id,
    status: event.presences_purged_at ? 'details_expired' : mismatchedDays.length || supportMismatchedDays.length ? 'mismatch' : 'consistent',
    total, supportTotal, mismatchedDays, supportMismatchedDays, finalized: Boolean(event.finalized_at)
  };
}

export async function reconcileEvent(eventId: string, options?: { finalize?: boolean; actor?: AdminActor }): Promise<ReconciliationReport> {
  return transaction(async (client) => {
    const event = await lockedEvent(client, eventId);
    const report = await reconcileLocked(client, event);
    if (!options?.finalize || event.finalized_at) return report;
    if (!options.actor) throw new Error('Finalization requires an operator and reason.');
    validateActor(options.actor);
    if (report.status !== 'consistent') throw new Error('Cannot finalize an inconsistent or purged event.');
    const { rows } = await client.query<{ ended: boolean }>('SELECT clock_timestamp() >= $1::timestamptz AS ended', [event.ends_at]);
    if (!rows[0] || (!rows[0].ended && !['closed', 'cancelled'].includes(event.status))) throw new Error('Close the event before finalization.');
    await client.query(`UPDATE events SET finalized_at=clock_timestamp(),
      status=CASE WHEN status='cancelled' THEN status ELSE 'closed' END,
      metadata_version=metadata_version+1, updated_at=clock_timestamp() WHERE id=$1`, [eventId]);
    await audit(client, options.actor, eventId, 'finalize', { total: report.total, supportTotal: report.supportTotal });
    return { ...report, finalized: true };
  });
}

export async function purgeEvent(eventId: string, actor: AdminActor): Promise<'purged' | 'already_purged'> {
  validateActor(actor);
  return transaction(async (client) => {
    const event = await lockedEvent(client, eventId);
    if (event.presences_purged_at) return 'already_purged';
    const { rows } = await client.query<{ due: boolean }>(
      "SELECT clock_timestamp() >= $1::timestamptz + interval '48 hours' AS due", [event.ends_at]);
    if (!rows[0]?.due) throw new Error('The retention deadline has not been reached.');
    const report = await reconcileLocked(client, event);
    if (report.status !== 'consistent') throw new Error('Counter mismatch: suspend and investigate before purging.');
    // Marker and deletion commit together. The event lock excludes admissions, admin changes and other purges.
    await client.query('DELETE FROM presences WHERE event_id=$1', [eventId]);
    await client.query('DELETE FROM supports WHERE event_id=$1', [eventId]);
    await client.query(`UPDATE events SET presences_purged_at=clock_timestamp(),
      finalized_at=COALESCE(finalized_at,clock_timestamp()),
      status=CASE WHEN status='cancelled' THEN status ELSE 'closed' END,
      metadata_version=metadata_version+1, updated_at=clock_timestamp() WHERE id=$1`, [eventId]);
    await audit(client, actor, eventId, 'purge', { retainedTotal: report.total, retainedSupportTotal: report.supportTotal });
    return 'purged';
  });
}

export async function purgeExpiredEvents(actor: AdminActor): Promise<{ purged: number; failed: string[] }> {
  validateActor(actor);
  const { rows } = await getPool().query<{ id: string }>(`
    SELECT id FROM events WHERE presences_purged_at IS NULL
      AND clock_timestamp() >= ends_at + interval '48 hours' ORDER BY ends_at LIMIT 100`);
  let purged = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try { if (await purgeEvent(row.id, actor) === 'purged') purged++; }
    catch { failed.push(row.id); }
  }
  // Operator data has its own documented six-month retention, unrelated to participants.
  await getPool().query("DELETE FROM admin_audit WHERE created_at < clock_timestamp() - interval '6 months'");
  await purgeExpiredDailySupportClaims();
  await getPool().query('DELETE FROM admission_claims WHERE expires_at <= clock_timestamp()');
  return { purged, failed };
}

/** Daily tokens are unlinked to events and are unnecessary after Paris midnight. */
export async function purgeExpiredDailySupportClaims(): Promise<number> {
  const result = await getPool().query("DELETE FROM daily_support_claims WHERE counting_day < (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date");
  return result.rowCount ?? 0;
}
