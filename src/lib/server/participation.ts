import type { PoolClient } from 'pg';
import type {
  AdmissionStatus, ParticipationPayload, ParticipationReply, PresenceStatusReply,
  SupportPayload, SupportReply, SupportStatus, SupportStatusReply
} from '../shared/types';
import { decodeAnonymousEventId, getPool, isEventId, realEventsApproved, transaction } from './db';
import { getCounterSnapshot, readCounterSnapshot } from './counters';
import type { EventRow } from './events';
import { consumeAdmission, type VerifiedAdmission } from './admission';
import { recordAdmissionEvent } from './integrity-metrics';

interface DecisionClock { counting_day: string; started: boolean; ended: boolean }

async function decisionClock(client: PoolClient, event: EventRow): Promise<DecisionClock> {
  // clock_timestamp() is evaluated after preceding lock and uniqueness waits.
  const { rows } = await client.query<DecisionClock>(`
    SELECT (instant AT TIME ZONE 'Europe/Paris')::date::text AS counting_day,
      instant >= $1::timestamptz AS started, instant >= $2::timestamptz AS ended
    FROM (SELECT clock_timestamp() AS instant) decision`, [event.starts_at, event.ends_at]);
  if (!rows[0]) throw new Error('Database decision clock unavailable.');
  return rows[0];
}

async function lockIdentity(client: PoolClient, eventId: string, anonymousEventId: string): Promise<void> {
  // This transaction-only lock serializes support/presence for one event token.
  // Its input never combines identities from different events or survives commit.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${eventId}:${anonymousEventId}`]);
}

function scopeStatus(event: EventRow, scope: unknown): AdmissionStatus | null {
  // Cached clients must explicitly confirm a full-commune declaration.
  if ((event.counting_scope ?? 'gathering') === 'city' && scope !== 'city') return 'scope_confirmation_required';
  if ((event.counting_scope ?? 'gathering') === 'gathering' && scope === 'city') return 'invalid_request';
  return null;
}

function eventAdmissionStatus(event: EventRow): AdmissionStatus | null {
  if (event.presences_purged_at || event.finalized_at) return 'ended';
  if (!event.is_test && !realEventsApproved()) return 'real_events_disabled';
  if (event.status === 'paused' || event.integrity_status === 'suspended') return 'paused';
  if (event.status === 'closed' || event.status === 'cancelled') return 'ended';
  return null;
}

// Network callers must supply verified work. The optional argument supports trusted internal maintenance/tests.
export async function registerPresence(eventId: string, payload: ParticipationPayload, isTest?: boolean, admission?: VerifiedAdmission): Promise<ParticipationReply> {
  const anonymousId = decodeAnonymousEventId(payload?.anonymousEventId);
  if (!isEventId(eventId) || !anonymousId || payload.protocolVersion !== 1 || payload.insideZone !== true ||
      !Number.isInteger(payload.geofenceVersion) || payload.geofenceVersion < 1 ||
      (payload.countingScope !== undefined && payload.countingScope !== 'gathering' && payload.countingScope !== 'city') ||
      Object.keys(payload).some((key) => !['anonymousEventId', 'geofenceVersion', 'protocolVersion', 'insideZone', 'countingScope'].includes(key))) {
    return { status: 'invalid_request' };
  }

  let converted = false;
  const status = await transaction<AdmissionStatus>(async (client) => {
    const { rows } = await client.query<EventRow>(
      "SELECT * FROM events WHERE id = $1 AND status <> 'draft' FOR SHARE", [eventId]);
    const event = rows[0];
    if (!event || (isTest !== undefined && event.is_test !== isTest)) return 'not_found';
    const scopeError = scopeStatus(event, payload.countingScope);
    if (scopeError) return scopeError;
    await lockIdentity(client, eventId, payload.anonymousEventId);
    const existing = await client.query('SELECT 1 FROM presences WHERE event_id = $1 AND anonymous_event_id = $2', [eventId, anonymousId]);
    if (existing.rowCount) return 'already_counted';
    const eventError = eventAdmissionStatus(event);
    if (eventError) return eventError;
    if (event.geofence_version !== payload.geofenceVersion || event.protocol_version !== payload.protocolVersion) return 'event_updated';

    // A counter row can also wait on another admission. If Paris midnight passes
    // during that wait, retry with the new day without keeping partial changes.
    for (let attempt = 0; attempt < 2; attempt++) {
      const decision = await decisionClock(client, event);
      if (!decision.started) return 'not_open';
      if (decision.ended) return 'ended';
      await client.query('SAVEPOINT presence_admission');
      if (admission && !await consumeAdmission(client, admission)) return 'admission_required';
      const inserted = await client.query(`
        INSERT INTO presences (event_id, anonymous_event_id, counting_day) VALUES ($1, $2, $3::date)
        ON CONFLICT (event_id, anonymous_event_id) DO NOTHING RETURNING event_id`, [eventId, anonymousId, decision.counting_day]);
      if (!inserted.rowCount) {
        await client.query('ROLLBACK TO SAVEPOINT presence_admission');
        return 'already_counted';
      }
      // A confirmed presence replaces an earlier support, including support from
      // a previous day of a multi-day event. Keep the unlinked daily claim.
      const removed = await client.query<{ counting_day: string }>(`
        DELETE FROM supports WHERE event_id=$1 AND anonymous_event_id=$2
        RETURNING counting_day::text`, [eventId, anonymousId]);
      if (removed.rows[0]) {
        const decremented = await client.query(`UPDATE support_counters
          SET count=count-1, revision=revision+1
          WHERE event_id=$1 AND counting_day=$2::date AND count>0`, [eventId, removed.rows[0].counting_day]);
        if (decremented.rowCount !== 1) throw new Error('Support counter mismatch.');
      }
      await client.query(`
        INSERT INTO event_counters (event_id, counting_day, count, revision) VALUES ($1, $2::date, 1, 1)
        ON CONFLICT (event_id, counting_day) DO UPDATE
        SET count = event_counters.count + 1, revision = event_counters.revision + 1`, [eventId, decision.counting_day]);
      const committedDecision = await decisionClock(client, event);
      if (committedDecision.ended || committedDecision.counting_day !== decision.counting_day) {
        await client.query('ROLLBACK TO SAVEPOINT presence_admission');
        await client.query('RELEASE SAVEPOINT presence_admission');
        if (committedDecision.ended) return 'ended';
        continue;
      }
      await client.query('RELEASE SAVEPOINT presence_admission');
      converted = Boolean(removed.rows[0]);
      return 'counted';
    }
    return 'temporarily_unavailable';
  });
  // Record after COMMIT, before the snapshot: a lost reply must not hide an admission.
  if (status === 'counted') {
    recordAdmissionEvent(eventId, 'presence');
    if (converted) recordAdmissionEvent(eventId, 'conversion');
  }
  if (status === 'admission_required') recordAdmissionEvent(eventId, 'proof_rejected');
  if (status === 'not_found') return { status };
  const snapshot = await getCounterSnapshot(eventId, isTest);
  return snapshot ? { status, snapshot } : { status: 'not_found' };
}

function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function registerSupport(eventId: string, payload: SupportPayload, isTest?: boolean, admission?: VerifiedAdmission): Promise<SupportReply> {
  const anonymousId = decodeAnonymousEventId(payload?.anonymousEventId);
  const anonymousDayId = decodeAnonymousEventId(payload?.anonymousDayId);
  if (!isEventId(eventId) || !anonymousId || !anonymousDayId || !validDay(payload?.day) || payload.protocolVersion !== 1 ||
      (payload.countingScope !== undefined && payload.countingScope !== 'gathering' && payload.countingScope !== 'city') ||
      Object.keys(payload).some((key) => !['anonymousEventId', 'anonymousDayId', 'day', 'protocolVersion', 'countingScope'].includes(key))) {
    return { status: 'invalid_request' };
  }

  const status = await transaction<SupportStatus>(async (client) => {
    const { rows } = await client.query<EventRow>(
      "SELECT * FROM events WHERE id = $1 AND status <> 'draft' FOR SHARE", [eventId]);
    const event = rows[0];
    if (!event || (isTest !== undefined && event.is_test !== isTest)) return 'not_found';
    const scopeError = scopeStatus(event, payload.countingScope);
    if (scopeError) return scopeError;
    await lockIdentity(client, eventId, payload.anonymousEventId);
    const existing = await client.query<{ present: boolean; supported: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM presences WHERE event_id=$1 AND anonymous_event_id=$2) AS present,
      EXISTS(SELECT 1 FROM supports WHERE event_id=$1 AND anonymous_event_id=$2) AS supported`, [eventId, anonymousId]);
    if (existing.rows[0]?.present) return 'already_present';
    if (existing.rows[0]?.supported) return 'already_supported';
    const eventError = eventAdmissionStatus(event);
    if (eventError) return eventError;
    if (event.protocol_version !== payload.protocolVersion) return 'event_updated';

    // Claims contain no event reference. Delete yesterday's tokens on new traffic
    // as well as during the scheduled retention sweep, even on quiet deployments.
    await client.query("DELETE FROM daily_support_claims WHERE counting_day < (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date");
    const decision = await decisionClock(client, event);
    if (decision.counting_day !== payload.day) return 'day_changed';
    if (!decision.started) return 'not_open';
    if (decision.ended) return 'ended';
    await client.query('SAVEPOINT support_admission');
    const claim = await client.query(`
      INSERT INTO daily_support_claims(counting_day, anonymous_day_id) VALUES($1::date,$2)
      ON CONFLICT (counting_day, anonymous_day_id) DO NOTHING RETURNING counting_day`, [payload.day, anonymousDayId]);
    // The unique daily token can wait for a concurrent support on another event.
    const afterClaim = await decisionClock(client, event);
    if (afterClaim.counting_day !== payload.day || afterClaim.ended) {
      await client.query('ROLLBACK TO SAVEPOINT support_admission');
      return afterClaim.ended ? 'ended' : 'day_changed';
    }
    if (!claim.rowCount) return 'daily_limit_reached';
    if (admission && !await consumeAdmission(client, admission)) {
      await client.query('ROLLBACK TO SAVEPOINT support_admission');
      return 'admission_required';
    }
    const inserted = await client.query(`
      INSERT INTO supports(event_id, anonymous_event_id, counting_day) VALUES($1,$2,$3::date)
      ON CONFLICT (event_id, anonymous_event_id) DO NOTHING RETURNING event_id`, [eventId, anonymousId, payload.day]);
    if (!inserted.rowCount) {
      await client.query('ROLLBACK TO SAVEPOINT support_admission');
      return 'already_supported';
    }
    await client.query(`
      INSERT INTO support_counters(event_id, counting_day, count, revision) VALUES($1,$2::date,1,1)
      ON CONFLICT (event_id, counting_day) DO UPDATE
      SET count=support_counters.count+1, revision=support_counters.revision+1`, [eventId, payload.day]);
    const committedDecision = await decisionClock(client, event);
    if (committedDecision.counting_day !== payload.day || committedDecision.ended) {
      await client.query('ROLLBACK TO SAVEPOINT support_admission');
      return committedDecision.ended ? 'ended' : 'day_changed';
    }
    await client.query('RELEASE SAVEPOINT support_admission');
    return 'supported';
  });
  if (status === 'supported') recordAdmissionEvent(eventId, 'support');
  if (status === 'admission_required') recordAdmissionEvent(eventId, 'proof_rejected');
  if (status === 'not_found') return { status };
  const snapshot = await getCounterSnapshot(eventId, isTest);
  return snapshot ? { status, snapshot } : { status: 'not_found' };
}

export async function getPresenceStatus(eventId: string, anonymousEventId: string, isTest?: boolean): Promise<PresenceStatusReply | null> {
  const anonymousId = decodeAnonymousEventId(anonymousEventId);
  if (!isEventId(eventId) || !anonymousId) return null;
  const result = await readCounterSnapshot(getPool(), eventId, anonymousId, isTest);
  if (!result) return null;
  return {
    status: result.detailsExpired ? 'details_expired' : result.exists ? 'counted' : 'not_counted',
    snapshot: result.snapshot
  };
}

export async function getSupportStatus(eventId: string, anonymousEventId: string, isTest?: boolean): Promise<SupportStatusReply | null> {
  const anonymousId = decodeAnonymousEventId(anonymousEventId);
  if (!isEventId(eventId) || !anonymousId) return null;
  const result = await readCounterSnapshot(getPool(), eventId, anonymousId, isTest);
  if (!result) return null;
  return {
    status: result.detailsExpired ? 'details_expired' : result.exists ? 'present' : result.supportExists ? 'supported' : 'not_supported',
    snapshot: result.snapshot
  };
}
