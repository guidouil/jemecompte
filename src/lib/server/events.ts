import { getPool, isEventId, realEventsApproved } from './db';
import type { CountingScope, EventGeofence, PublicEvent } from '../shared/types';
import { PUBLIC_CATALOGUE_LIMIT } from '../shared/event-creation';

export interface EventRow {
  id: string; slug: string; name: string; city_code: string; city_name: string;
  description: string | null; geofence: EventGeofence; geofence_version: number; metadata_version: number;
  counting_scope?: CountingScope;
  starts_at: Date; ends_at: Date; status: PublicEvent['status']; integrity_status: PublicEvent['integrityStatus'];
  protocol_version: 1; is_test: boolean; finalized_at: Date | null; presences_purged_at: Date | null;
  creation_source?: 'team' | 'community'; creation_request_hash?: Buffer | null;
}

export function publicEvent(row: EventRow): PublicEvent {
  return {
    id: row.id, slug: row.slug, name: row.name, cityCode: row.city_code, cityName: row.city_name,
    description: row.description, geofence: row.geofence, geofenceVersion: row.geofence_version,
    countingScope: row.counting_scope ?? 'gathering',
    metadataVersion: row.metadata_version, startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(),
    status: row.status, integrityStatus: row.integrity_status, protocolVersion: row.protocol_version,
    isTest: row.is_test, finalizedAt: row.finalized_at?.toISOString() ?? null,
    creationSource: row.creation_source ?? 'team',
    presencesPurgedAt: row.presences_purged_at?.toISOString() ?? null
  };
}

export async function listPublicEvents(isTest = !realEventsApproved()): Promise<PublicEvent[]> {
  const { rows } = await getPool().query<EventRow>(`
    WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS instant)
    SELECT e.* FROM events e CROSS JOIN decision WHERE status <> 'draft' AND is_test = $2
      AND starts_at >= instant - interval '7 days'
    ORDER BY CASE
      WHEN status='published' AND integrity_status <> 'suspended' AND starts_at<=instant
        AND ends_at>instant AND finalized_at IS NULL THEN 0
      WHEN status='published' AND starts_at>instant THEN 1 ELSE 2 END,
      CASE WHEN starts_at>instant THEN starts_at END ASC,
      starts_at DESC, id LIMIT $1`, [PUBLIC_CATALOGUE_LIMIT, isTest]);
  return rows.map(publicEvent);
}

export async function getEventBySlug(slug: string, isTest = !realEventsApproved()): Promise<PublicEvent | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) return null;
  const { rows } = await getPool().query<EventRow>("SELECT * FROM events WHERE slug = $1 AND status <> 'draft' AND is_test = $2", [slug, isTest]);
  return rows[0] ? publicEvent(rows[0]) : null;
}

export async function getEventById(id: string): Promise<PublicEvent | null> {
  if (!isEventId(id)) return null;
  const { rows } = await getPool().query<EventRow>("SELECT * FROM events WHERE id = $1 AND status <> 'draft'", [id]);
  return rows[0] ? publicEvent(rows[0]) : null;
}
