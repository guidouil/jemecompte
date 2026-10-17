import { createHash } from 'node:crypto';
import { createEventPayloadSchema, type CreateEventReply } from '../shared/event-creation';
import { circlePolygon } from '../shared/geo';
import { isInsideGeofence, validateGeofence } from '../shared/geofence';
import type { EventGeofence } from '../shared/types';
import { getPool, realEventsApproved, transaction } from './db';
import { publicEvent, type EventRow } from './events';
import { invalidatePublicCatalogue } from './public-data';
import { getPublicPlaceBoundary } from './maps';
import { consumeAdmission, type VerifiedAdmission } from './admission';

class InvalidScheduleError extends Error {}

export async function createPublicEvent(input: unknown, admission?: VerifiedAdmission): Promise<CreateEventReply> {
  const payload = createEventPayloadSchema.parse(input);
  // Only public configuration is hashed. No network signal, device key or creator identity enters the database.
  const publicFields = payload.countingScope === 'city' ? [
    'city', payload.name, payload.cityName, payload.cityCode,
    payload.durationMinutes, payload.publicLocationConfirmed
  ] : [
    payload.name, payload.cityName, payload.cityCode, payload.publicCenter,
    payload.radiusMeters, payload.durationMinutes, payload.publicLocationConfirmed
  ];
  // Keep the original digest for immediate requests made before scheduling existed.
  if (payload.startsAt !== undefined) publicFields.push(payload.startsAt);
  const digest = createHash('sha256').update(JSON.stringify(publicFields)).digest();
  // Preserve every committed request, including historical declared names and locations,
  // without consulting cartography again or rewriting its original public configuration.
  const expectedScope = payload.countingScope === 'city' ? 'city' : 'gathering';
  const existingRequest = async (): Promise<CreateEventReply | null> => {
    const { rows } = await getPool().query<EventRow>('SELECT * FROM events WHERE id=$1', [payload.requestId]);
    const row = rows[0];
    if (!row) return null;
    if (row.creation_source !== 'community' || (row.counting_scope ?? 'gathering') !== expectedScope || !row.creation_request_hash?.equals(digest)) {
      return { status: 'request_conflict' };
    }
    invalidatePublicCatalogue();
    return { status: 'already_created', event: publicEvent(row) };
  };
  const replay = await existingRequest();
  if (replay) return replay;
  let cityName: string;
  let geofence: EventGeofence;
  try {
    const boundary = await getPublicPlaceBoundary(payload.cityCode);
    cityName = boundary.name;
    if (payload.countingScope === 'city') {
      geofence = boundary.geofence;
    } else {
      // This is the deliberately selected public gathering center, never a participant fix.
      // The circle can cross municipal boundaries; its attribution follows its center.
      if (!isInsideGeofence(payload.publicCenter[0], payload.publicCenter[1], boundary.geofence)) {
        return await existingRequest() ?? { status: 'invalid_location' };
      }
      geofence = validateGeofence(circlePolygon(payload.publicCenter, payload.radiusMeters));
    }
  } catch {
    // Another request may have committed while this one was waiting for the provider.
    return await existingRequest() ?? { status: 'temporarily_unavailable' };
  }
  const base = payload.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50).replace(/-$/, '') || 'rassemblement';
  const slug = `${base}-${payload.requestId}`;
  const isTest = !realEventsApproved();
  let result: CreateEventReply;
  try {
    result = await transaction<CreateEventReply>(async (client) => {
      if (admission && !await consumeAdmission(client, admission)) return { status: 'admission_required' };
      const { rows } = await client.query<EventRow & { schedule_valid: boolean }>(`
        WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS instant)
        INSERT INTO events
          (id,slug,name,city_code,city_name,description,geofence,starts_at,ends_at,status,is_test,creation_source,creation_request_hash${payload.countingScope === 'city' ? ',counting_scope' : ''})
        SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,
          COALESCE($11::timestamptz,instant),COALESCE($11::timestamptz,instant)+($8::integer * interval '1 minute'),
          'published',$9,'community',$10${payload.countingScope === 'city' ? ',$12' : ''} FROM decision
        ON CONFLICT (id) DO NOTHING RETURNING *,ends_at>clock_timestamp() AS schedule_valid`, [
        payload.requestId, slug, payload.name,
        payload.cityCode, cityName,
        payload.countingScope === 'city'
          ? 'Comptage créé publiquement sur le périmètre administratif de la commune fourni par l’API Découpage administratif. Le nom du comptage est déclaré par le créateur.'
          : 'Rassemblement créé publiquement. Nom et rayon déclarés par le créateur. Commune résolue auprès de l’API Découpage administratif ; le centre public choisi appartient à son contour officiel. Le cercle peut dépasser cette commune et l’existence du rassemblement n’est pas vérifiée.',
        JSON.stringify(geofence), payload.durationMinutes, isTest, digest, payload.startsAt ?? null,
        ...(payload.countingScope === 'city' ? ['city'] : [])
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
