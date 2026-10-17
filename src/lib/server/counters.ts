import { counterEpoch, getPool, isEventId, type DatabaseConnection } from './db';
import type { CountingScope, CounterSnapshot } from '../shared/types';

interface SnapshotRow {
  event_id: string; total: string; revision: string; day: string; national_total: string;
  national_revision: string; city_total: string; city_revision: string; server_time: Date;
  support_total: string; support_revision: string; national_support_total: string;
  national_support_revision: string; city_support_total: string; city_support_revision: string;
  status: CounterSnapshot['eventStatus']; integrity_status: CounterSnapshot['integrityStatus'];
  metadata_version: number; starts_at: Date; ends_at: Date; presence_exists: boolean; details_expired: boolean;
  counting_scope: CountingScope; support_exists: boolean;
}

/** One statement = one MVCC snapshot, including the optional individual status and purge marker. */
export async function readCounterSnapshot(
  connection: DatabaseConnection, eventId: string, anonymousId: Buffer | null = null, isTest?: boolean
): Promise<{ snapshot: CounterSnapshot; exists: boolean; supportExists: boolean; detailsExpired: boolean } | null> {
  const { rows } = await connection.query<SnapshotRow>(`
    WITH target AS (SELECT * FROM events WHERE id = $1 AND status <> 'draft'
      AND ($3::boolean IS NULL OR is_test = $3)),
    current_clock AS MATERIALIZED (SELECT statement_timestamp() AS instant),
    current_day AS (SELECT (instant AT TIME ZONE 'Europe/Paris')::date AS day, instant FROM current_clock)
    SELECT target.id AS event_id, target.counting_scope, target.status, target.integrity_status, target.metadata_version,
      target.starts_at, target.ends_at, current_day.day::text, current_day.instant AS server_time,
      COALESCE(own.total, 0)::text AS total, COALESCE(own.revision, 0)::text AS revision,
      COALESCE(daily.national_total, 0)::text AS national_total,
      COALESCE(daily.national_revision, 0)::text AS national_revision,
      COALESCE(daily.city_total, 0)::text AS city_total,
      COALESCE(daily.city_revision, 0)::text AS city_revision,
      COALESCE(own_support.total, 0)::text AS support_total,
      COALESCE(own_support.revision, 0)::text AS support_revision,
      COALESCE(daily_support.national_total, 0)::text AS national_support_total,
      COALESCE(daily_support.national_revision, 0)::text AS national_support_revision,
      COALESCE(daily_support.city_total, 0)::text AS city_support_total,
      COALESCE(daily_support.city_revision, 0)::text AS city_support_revision,
      target.presences_purged_at IS NOT NULL AS details_expired,
      CASE WHEN $2::bytea IS NULL THEN false ELSE EXISTS (
        SELECT 1 FROM presences p WHERE p.event_id = target.id AND p.anonymous_event_id = $2
      ) END AS presence_exists,
      CASE WHEN $2::bytea IS NULL THEN false ELSE EXISTS (
        SELECT 1 FROM supports s WHERE s.event_id = target.id AND s.anonymous_event_id = $2
      ) END AS support_exists
    FROM target CROSS JOIN current_day
    LEFT JOIN LATERAL (
      SELECT sum(c.count) AS total, sum(c.revision) AS revision
      FROM event_counters c WHERE c.event_id = target.id
    ) own ON true
    LEFT JOIN LATERAL (
      SELECT sum(c.count) AS national_total, sum(c.revision) AS national_revision,
        sum(c.count) FILTER (WHERE e.city_code = target.city_code) AS city_total,
        sum(c.revision) FILTER (WHERE e.city_code = target.city_code) AS city_revision
      FROM event_counters c JOIN events e ON e.id = c.event_id
      WHERE c.counting_day = current_day.day AND e.is_test = target.is_test
        AND e.counting_scope = target.counting_scope
    ) daily ON true
    LEFT JOIN LATERAL (
      SELECT sum(c.count) AS total, sum(c.revision) AS revision
      FROM support_counters c WHERE c.event_id = target.id
    ) own_support ON true
    LEFT JOIN LATERAL (
      SELECT sum(c.count) AS national_total, sum(c.revision) AS national_revision,
        sum(c.count) FILTER (WHERE e.city_code = target.city_code) AS city_total,
        sum(c.revision) FILTER (WHERE e.city_code = target.city_code) AS city_revision
      FROM support_counters c JOIN events e ON e.id = c.event_id
      WHERE c.counting_day = current_day.day AND e.is_test = target.is_test
        AND e.counting_scope = target.counting_scope
    ) daily_support ON true`, [eventId, anonymousId, isTest ?? null]);
  const row = rows[0];
  if (!row) return null;
  return {
    snapshot: {
      eventId: row.event_id, total: row.total, revision: row.revision, day: row.day,
      countingScope: row.counting_scope,
      nationalTotal: row.national_total, nationalRevision: row.national_revision,
      cityTotal: row.city_total, cityRevision: row.city_revision, epoch: counterEpoch(),
      supportTotal: row.support_total, supportRevision: row.support_revision,
      nationalSupportTotal: row.national_support_total, nationalSupportRevision: row.national_support_revision,
      citySupportTotal: row.city_support_total, citySupportRevision: row.city_support_revision,
      serverTime: row.server_time.toISOString(), eventStatus: row.status,
      integrityStatus: row.integrity_status, metadataVersion: row.metadata_version,
      startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString()
    }, exists: row.presence_exists, supportExists: row.support_exists, detailsExpired: row.details_expired
  };
}

export async function getCounterSnapshot(eventId: string, isTest?: boolean): Promise<CounterSnapshot | null> {
  if (!isEventId(eventId)) return null;
  return (await readCounterSnapshot(getPool(), eventId, null, isTest))?.snapshot ?? null;
}

export async function getNationalTotal(isTest = true, countingScope: CountingScope = 'gathering'): Promise<string> {
  const { rows } = await getPool().query<{ total: string }>(`
    WITH current_day AS MATERIALIZED (
      SELECT (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date AS day
    )
    SELECT COALESCE(sum(c.count), 0)::text AS total
    FROM event_counters c JOIN events e ON e.id = c.event_id CROSS JOIN current_day
    WHERE e.is_test = $1 AND e.counting_scope = $2 AND c.counting_day = current_day.day`, [isTest, countingScope]);
  return rows[0]?.total ?? '0';
}

export async function getNationalSupportTotal(isTest = true, countingScope: CountingScope = 'gathering'): Promise<string> {
  const { rows } = await getPool().query<{ total: string }>(`
    WITH current_day AS MATERIALIZED (
      SELECT (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date AS day
    )
    SELECT COALESCE(sum(c.count), 0)::text AS total
    FROM support_counters c JOIN events e ON e.id = c.event_id CROSS JOIN current_day
    WHERE e.is_test = $1 AND e.counting_scope = $2 AND c.counting_day = current_day.day`, [isTest, countingScope]);
  return rows[0]?.total ?? '0';
}

export interface NationalTotals { total: string; supportTotal: string }

/** Read both categories in one MVCC snapshot so conversions preserve the combined total. */
export async function getNationalTotals(isTest = true, countingScope: CountingScope = 'gathering'): Promise<NationalTotals> {
  const { rows } = await getPool().query<{ total: string; support_total: string }>(`
    WITH current_day AS MATERIALIZED (
      SELECT (statement_timestamp() AT TIME ZONE 'Europe/Paris')::date AS day
    ), matching AS MATERIALIZED (
      SELECT id FROM events WHERE is_test=$1 AND counting_scope=$2
    )
    SELECT COALESCE((SELECT sum(c.count) FROM event_counters c JOIN matching e ON e.id=c.event_id
      CROSS JOIN current_day WHERE c.counting_day=current_day.day),0)::text AS total,
      COALESCE((SELECT sum(c.count) FROM support_counters c JOIN matching e ON e.id=c.event_id
      CROSS JOIN current_day WHERE c.counting_day=current_day.day),0)::text AS support_total`, [isTest, countingScope]);
  return { total: rows[0]?.total ?? '0', supportTotal: rows[0]?.support_total ?? '0' };
}
