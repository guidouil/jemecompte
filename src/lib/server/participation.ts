import type { AdmissionStatus, ParticipationPayload, ParticipationReply, PresenceStatusReply } from '../shared/types';
import { decodeAnonymousEventId, getPool, isEventId, realEventsApproved, transaction } from './db';
import { getCounterSnapshot, readCounterSnapshot } from './counters';
import type { EventRow } from './events';

export async function registerPresence(eventId: string, payload: ParticipationPayload): Promise<ParticipationReply> {
  const anonymousId = decodeAnonymousEventId(payload?.anonymousEventId);
  if (!isEventId(eventId) || !anonymousId || payload.protocolVersion !== 1 || payload.insideZone !== true ||
      !Number.isInteger(payload.geofenceVersion) || payload.geofenceVersion < 1 ||
      Object.keys(payload).some((key) => !['anonymousEventId', 'geofenceVersion', 'protocolVersion', 'insideZone'].includes(key))) {
    return { status: 'invalid_request' };
  }

  const status = await transaction<AdmissionStatus>(async (client) => {
    const { rows } = await client.query<EventRow>(
      "SELECT * FROM events WHERE id = $1 AND status <> 'draft' FOR SHARE", [eventId]);
    const event = rows[0];
    if (!event) return 'not_found';

    const existing = await client.query('SELECT 1 FROM presences WHERE event_id = $1 AND anonymous_event_id = $2', [eventId, anonymousId]);
    if (existing.rowCount) return 'already_counted';
    if (event.presences_purged_at || event.finalized_at) return 'ended';
    if (!event.is_test && !realEventsApproved()) return 'real_events_disabled';
    if (event.status === 'paused' || event.integrity_status === 'suspended') return 'paused';
    if (event.status === 'closed' || event.status === 'cancelled') return 'ended';
    if (event.geofence_version !== payload.geofenceVersion || event.protocol_version !== payload.protocolVersion) return 'event_updated';

    // Intentionally after acquiring FOR SHARE; CURRENT_TIMESTAMP would precede a lock wait.
    const clock = await client.query<{ counting_day: string; started: boolean; ended: boolean }>(`
      SELECT (instant AT TIME ZONE 'Europe/Paris')::date::text AS counting_day,
        instant >= $1::timestamptz AS started, instant >= $2::timestamptz AS ended
      FROM (SELECT clock_timestamp() AS instant) decision`, [event.starts_at, event.ends_at]);
    const decision = clock.rows[0];
    if (!decision) throw new Error('Database decision clock unavailable.');
    if (!decision.started) return 'not_open';
    if (decision.ended) return 'ended';

    const inserted = await client.query(`
      INSERT INTO presences (event_id, anonymous_event_id, counting_day) VALUES ($1, $2, $3::date)
      ON CONFLICT (event_id, anonymous_event_id) DO NOTHING RETURNING event_id`, [eventId, anonymousId, decision.counting_day]);
    if (!inserted.rowCount) return 'already_counted';
    await client.query(`
      INSERT INTO event_counters (event_id, counting_day, count, revision) VALUES ($1, $2::date, 1, 1)
      ON CONFLICT (event_id, counting_day) DO UPDATE
      SET count = event_counters.count + 1, revision = event_counters.revision + 1`, [eventId, decision.counting_day]);
    return 'counted';
  });
  if (status === 'not_found') return { status };
  const snapshot = await getCounterSnapshot(eventId);
  return snapshot ? { status, snapshot } : { status: 'not_found' };
}

export async function getPresenceStatus(eventId: string, anonymousEventId: string): Promise<PresenceStatusReply | null> {
  const anonymousId = decodeAnonymousEventId(anonymousEventId);
  if (!isEventId(eventId) || !anonymousId) return null;
  const result = await readCounterSnapshot(getPool(), eventId, anonymousId);
  if (!result) return null;
  return {
    status: result.detailsExpired ? 'details_expired' : result.exists ? 'counted' : 'not_counted',
    snapshot: result.snapshot
  };
}
