import { createHash } from 'node:crypto';
import { createEventPayloadSchema, type CreateEventReply } from '../shared/event-creation';
import { circlePolygon } from '../shared/geo';
import { validateGeofence } from '../shared/geofence';
import { realEventsApproved, transaction } from './db';
import { publicEvent, type EventRow } from './events';
import { invalidatePublicCatalogue } from './public-data';

class InvalidScheduleError extends Error {}

export async function createPublicEvent(input: unknown): Promise<CreateEventReply> {
  const payload = createEventPayloadSchema.parse(input);
  // Only public configuration is hashed. No network signal, device key or creator identity enters the database.
  const publicFields = [
    payload.name, payload.cityName, payload.cityCode, payload.publicCenter,
    payload.radiusMeters, payload.durationMinutes, payload.publicLocationConfirmed
  ];
  // Keep the original digest for immediate requests made before scheduling existed.
  if (payload.startsAt !== undefined) publicFields.push(payload.startsAt);
  const digest = createHash('sha256').update(JSON.stringify(publicFields)).digest();
  const geofence = validateGeofence(circlePolygon(payload.publicCenter, payload.radiusMeters));
  const base = payload.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50).replace(/-$/, '') || 'rassemblement';
  const slug = `${base}-${payload.requestId}`;
  const isTest = !realEventsApproved();
  let result: CreateEventReply;
  try {
    result = await transaction<CreateEventReply>(async (client) => {
      const { rows } = await client.query<EventRow & { schedule_valid: boolean }>(`
        WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS instant)
        INSERT INTO events
          (id,slug,name,city_code,city_name,description,geofence,starts_at,ends_at,status,is_test,creation_source,creation_request_hash)
        SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,
          COALESCE($11::timestamptz,instant),COALESCE($11::timestamptz,instant)+($8::integer * interval '1 minute'),
          'published',$9,'community',$10 FROM decision
        ON CONFLICT (id) DO NOTHING RETURNING *,ends_at>clock_timestamp() AS schedule_valid`, [
        payload.requestId, slug, payload.name,
        payload.cityCode, payload.cityName,
        'Événement créé publiquement. Nom, commune et périmètre déclarés par le créateur, sans vérification indépendante de leur correspondance.',
        JSON.stringify(geofence), payload.durationMinutes, isTest, digest, payload.startsAt ?? null
      ]);
      if (rows[0]) {
        // Validate only a genuinely new INSERT, after any uniqueness wait. Throwing rolls
        // it back without requiring DELETE privileges or leaving an expired event behind.
        if (!rows[0].schedule_valid) throw new InvalidScheduleError();
        return { status: 'created', event: publicEvent(rows[0]) };
      }
      // A fresh statement sees the concurrent INSERT that ON CONFLICT may have waited for.
      const existing = await client.query<EventRow>('SELECT * FROM events WHERE id=$1 FOR SHARE', [payload.requestId]);
      const row = existing.rows[0];
      if (!row || row.creation_source !== 'community' || !row.creation_request_hash?.equals(digest)) {
        return { status: 'request_conflict' };
      }
      return { status: 'already_created', event: publicEvent(row) };
    });
  } catch (error) {
    if (error instanceof InvalidScheduleError) return { status: 'invalid_schedule' };
    throw error;
  }
  if (result.status === 'created' || result.status === 'already_created') invalidatePublicCatalogue();
  return result;
}
