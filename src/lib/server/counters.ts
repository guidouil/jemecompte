import { counterEpoch, getPool, isEventId, type DatabaseConnection } from './db';
import type { CounterSnapshot } from '../shared/types';

interface SnapshotRow {
  event_id: string; total: string; revision: string; day: string; national_total: string;
  national_revision: string; city_total: string; city_revision: string; server_time: Date;
  status: CounterSnapshot['eventStatus']; integrity_status: CounterSnapshot['integrityStatus'];
  metadata_version: number; starts_at: Date; ends_at: Date; presence_exists: boolean; details_expired: boolean;
}

/** One statement = one MVCC snapshot, including the optional individual status and purge marker. */
export async function readCounterSnapshot(
  connection: DatabaseConnection, eventId: string, anonymousId: Buffer | null = null
): Promise<{ snapshot: CounterSnapshot; exists: boolean; detailsExpired: boolean } | null> {
  const { rows } = await connection.query<SnapshotRow>(`
    WITH target AS (SELECT * FROM events WHERE id = $1 AND status <> 'draft'),
    current_clock AS MATERIALIZED (SELECT clock_timestamp() AS instant),
    current_day AS (SELECT (instant AT TIME ZONE 'Europe/Paris')::date AS day, instant FROM current_clock)
    SELECT target.id AS event_id, target.status, target.integrity_status, target.metadata_version,
      target.starts_at, target.ends_at, current_day.day::text, current_day.instant AS server_time,
      COALESCE(own.total, 0)::text AS total, COALESCE(own.revision, 0)::text AS revision,
      COALESCE(daily.national_total, 0)::text AS national_total,
      COALESCE(daily.national_revision, 0)::text AS national_revision,
      COALESCE(daily.city_total, 0)::text AS city_total,
      COALESCE(daily.city_revision, 0)::text AS city_revision,
      target.presences_purged_at IS NOT NULL AS details_expired,
      CASE WHEN $2::bytea IS NULL THEN false ELSE EXISTS (
        SELECT 1 FROM presences p WHERE p.event_id = target.id AND p.anonymous_event_id = $2
      ) END AS presence_exists
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
    ) daily ON true`, [eventId, anonymousId]);
  const row = rows[0];
  if (!row) return null;
  return {
    snapshot: {
      eventId: row.event_id, total: row.total, revision: row.revision, day: row.day,
      nationalTotal: row.national_total, nationalRevision: row.national_revision,
      cityTotal: row.city_total, cityRevision: row.city_revision, epoch: counterEpoch(),
      serverTime: row.server_time.toISOString(), eventStatus: row.status,
      integrityStatus: row.integrity_status, metadataVersion: row.metadata_version,
      startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString()
    }, exists: row.presence_exists, detailsExpired: row.details_expired
  };
}

export async function getCounterSnapshot(eventId: string): Promise<CounterSnapshot | null> {
  if (!isEventId(eventId)) return null;
  return (await readCounterSnapshot(getPool(), eventId))?.snapshot ?? null;
}

export async function getNationalTotal(isTest = true): Promise<string> {
  const { rows } = await getPool().query<{ total: string }>(`
    WITH current_day AS MATERIALIZED (
      SELECT (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date AS day
    )
    SELECT COALESCE(sum(c.count), 0)::text AS total
    FROM event_counters c JOIN events e ON e.id = c.event_id CROSS JOIN current_day
    WHERE e.is_test = $1 AND c.counting_day = current_day.day`, [isTest]);
  return rows[0]?.total ?? '0';
}
