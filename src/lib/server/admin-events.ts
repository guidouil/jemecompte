import type { CountingScope, EventStatus } from '../shared/types';
import { getAdminPool, isEventId, adminTransaction } from './db';
import { validateActor, type AdminActor } from './db/admin';
import { invalidatePublicEvent } from './public-data';
import { closeEventStreams } from './realtime';

export const ADMIN_EVENT_PAGE_SIZE = 40;

export interface AdminEventSummary {
  id: string;
  slug: string;
  name: string;
  cityName: string;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  isTest: boolean;
  countingScope: CountingScope;
  presenceCount: string;
  supportCount: string;
  totalCount: string;
  retainedPresences: string;
  retainedSupports: string;
}

export interface AdminEventPage {
  events: AdminEventSummary[];
  page: number;
  pageSize: number;
  hasNext: boolean;
}

interface SummaryRow {
  id: string; slug: string; name: string; city_name: string; starts_at: Date; ends_at: Date;
  status: EventStatus; is_test: boolean; counting_scope: CountingScope;
  presence_count: string; support_count: string; retained_presences: string; retained_supports: string;
}

/** Private administrative summaries only: no geometry, creator hash or participant identifier. */
export async function listAdminEvents(options: { page?: number; q?: string } = {}): Promise<AdminEventPage> {
  const page = Number.isSafeInteger(options.page) && options.page! >= 1 && options.page! <= 1_000_000 ? options.page! : 1;
  const q = typeof options.q === 'string' ? options.q.trim().slice(0, 120) : '';
  const { rows } = await getAdminPool().query<SummaryRow>(`
    WITH selected AS (
      SELECT id,slug,name,city_name,starts_at,ends_at,status,is_test,counting_scope,created_at
      FROM events
      WHERE $1::text='' OR strpos(lower(concat_ws(' ',name,city_name,slug,id::text)),lower($1))>0
      ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3
    )
    SELECT selected.id,slug,name,city_name,starts_at,ends_at,status,is_test,counting_scope,
      COALESCE((SELECT sum(count) FROM event_counters WHERE event_id=selected.id),0)::text AS presence_count,
      COALESCE((SELECT sum(count) FROM support_counters WHERE event_id=selected.id),0)::text AS support_count,
      (SELECT count(*)::text FROM presences WHERE event_id=selected.id) AS retained_presences,
      (SELECT count(*)::text FROM supports WHERE event_id=selected.id) AS retained_supports
    FROM selected ORDER BY created_at DESC,id DESC`, [q, ADMIN_EVENT_PAGE_SIZE + 1, (page - 1) * ADMIN_EVENT_PAGE_SIZE]);
  return {
    page, pageSize: ADMIN_EVENT_PAGE_SIZE, hasNext: rows.length > ADMIN_EVENT_PAGE_SIZE,
    events: rows.slice(0, ADMIN_EVENT_PAGE_SIZE).map((row) => ({
      id: row.id, slug: row.slug, name: row.name, cityName: row.city_name,
      startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), status: row.status,
      isTest: row.is_test, countingScope: row.counting_scope,
      presenceCount: row.presence_count, supportCount: row.support_count,
      totalCount: (BigInt(row.presence_count) + BigInt(row.support_count)).toString(),
      retainedPresences: row.retained_presences, retainedSupports: row.retained_supports
    }))
  };
}

export type DeleteAdminEventResult =
  | { status: 'not_found' }
  | { status: 'confirmation_mismatch' }
  | {
    status: 'deleted'; eventId: string; slug: string; removedCount: string; deletedPresences: string;
    deletedCounterRows: number; detachedAuditRows: number;
  };

/** Caller must authenticate the operator. A matching public slug is required for every deletion. */
export async function deleteAdminEvent(eventId: string, confirmationSlug: string, actor: AdminActor): Promise<DeleteAdminEventResult> {
  validateActor(actor);
  if (!isEventId(eventId)) return { status: 'not_found' };
  const result = await adminTransaction<DeleteAdminEventResult>(async (client) => {
    // Admissions hold FOR SHARE; reconciliation, purge and administration use FOR UPDATE.
    // Acquiring the same event lock first gives one serial order, including the final count.
    const { rows } = await client.query<{ id: string; slug: string }>('SELECT id,slug FROM events WHERE id=$1 FOR UPDATE', [eventId]);
    const event = rows[0];
    if (!event) return { status: 'not_found' };
    if (confirmationSlug !== event.slug) return { status: 'confirmation_mismatch' };
    const total = await client.query<{ total: string; support_total: string }>(`
      SELECT COALESCE(sum(count),0)::text AS total,
        (SELECT COALESCE(sum(count),0)::text FROM support_counters WHERE event_id=$1) AS support_total
      FROM event_counters WHERE event_id=$1`, [event.id]);
    const presences = await client.query<{ total: string; deleted_supports: string; deleted_support_counter_rows: number }>(`
      WITH removed AS (DELETE FROM presences WHERE event_id=$1 RETURNING 1),
        removed_supports AS (DELETE FROM supports WHERE event_id=$1 RETURNING 1),
        removed_support_counters AS (DELETE FROM support_counters WHERE event_id=$1 RETURNING 1)
      SELECT count(*)::text AS total,
        (SELECT count(*)::text FROM removed_supports) AS deleted_supports,
        (SELECT count(*)::integer FROM removed_support_counters) AS deleted_support_counter_rows
      FROM removed`, [event.id]);
    const counters = await client.query('DELETE FROM event_counters WHERE event_id=$1', [event.id]);
    // Keep the existing administrative history without its restrictive event FK.
    const detached = await client.query('UPDATE admin_audit SET event_id=NULL WHERE event_id=$1', [event.id]);
    await client.query('DELETE FROM events WHERE id=$1', [event.id]);
    const deleted = {
      status: 'deleted' as const, eventId: event.id, slug: event.slug,
      removedCount: total.rows[0]!.total, deletedPresences: presences.rows[0]!.total,
      deletedCounterRows: counters.rowCount ?? 0, detachedAuditRows: detached.rowCount ?? 0
    };
    // Public event identity and aggregate counts only. No participant IDs are selected or audited.
    await client.query(`INSERT INTO admin_audit(event_id,operator,action,reason,configuration)
      VALUES(NULL,$1,'delete_event',$2,$3::jsonb)`, [actor.operator, actor.reason, JSON.stringify({
      deletedEventId: deleted.eventId, slug: deleted.slug, removedCount: deleted.removedCount,
      deletedPresences: deleted.deletedPresences, deletedCounterRows: deleted.deletedCounterRows,
      ...((total.rows[0]?.support_total ?? '0') !== '0' || (presences.rows[0]?.deleted_supports ?? '0') !== '0' || (presences.rows[0]?.deleted_support_counter_rows ?? 0) > 0 ? {
        removedSupportCount: total.rows[0]!.support_total,
        deletedSupports: presences.rows[0]!.deleted_supports,
        deletedSupportCounterRows: presences.rows[0]!.deleted_support_counter_rows
      } : {})
    })]);
    return deleted;
  });
  // Publish invalidation only once the database transaction has actually committed.
  if (result.status === 'deleted') {
    invalidatePublicEvent(result.eventId);
    closeEventStreams(result.eventId);
  }
  return result;
}
