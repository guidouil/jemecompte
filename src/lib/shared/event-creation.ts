import { z } from 'zod';
import type { PublicEvent } from './types';
import { MIN_EVENT_RADIUS_METERS, MAX_EVENT_RADIUS_METERS, EVENT_DURATIONS } from './event-limits';

export const PUBLIC_CATALOGUE_LIMIT = 500;

// Broad discovery bounds, deliberately not a claim about exact national borders.
const SUPPORTED_REGIONS = [
  [-5.5, 41.2, 9.8, 51.2], // Métropole and Corsica
  [-61.85, 15.75, -60.9, 16.6], // Guadeloupe
  [-61.3, 14.35, -60.75, 14.95], // Martinique
  [-54.75, 2.0, -51.55, 5.9], // Guyane
  [55.15, -21.45, 55.9, -20.8], // Réunion
  [44.9, -13.1, 45.35, -12.6] // Mayotte
] as const;

export function isSupportedPublicCenter(center: readonly [number, number]): boolean {
  const [longitude, latitude] = center;
  return Number.isFinite(longitude) && Number.isFinite(latitude) &&
    SUPPORTED_REGIONS.some(([west, south, east, north]) =>
      longitude >= west && longitude <= east && latitude >= south && latitude <= north);
}

const publicText = (minimum: number, maximum: number) => z.string()
  .refine((value) => !/[\p{Cc}\p{Cf}<>]/u.test(value), 'Utilisez un texte sans balises ni caractères de contrôle.')
  .transform((value) => value.trim())
  .pipe(z.string().min(minimum).max(maximum));

const commonPublicFields = {
  requestId: z.uuid().transform((value) => value.toLowerCase()),
  name: publicText(3, 120),
  cityName: publicText(2, 100),
  cityCode: z.string().regex(/^[0-9AB]{5}$/),
  durationMinutes: z.literal(EVENT_DURATIONS),
  startsAt: z.iso.datetime({ offset: true })
    .refine((value) => Number.isFinite(Date.parse(value)), 'Choisissez une date de début valide.')
    .transform((value) => new Date(value).toISOString()).optional(),
  publicLocationConfirmed: z.literal(true)
};

export const createEventPayloadSchema = z.union([
  z.object({
    ...commonPublicFields,
    countingScope: z.literal('gathering').optional(),
    publicCenter: z.tuple([z.number().finite(), z.number().finite()])
      .refine(isSupportedPublicCenter, 'Choisissez un lieu dans une des zones françaises prises en charge.'),
    radiusMeters: z.number().int().min(MIN_EVENT_RADIUS_METERS).max(MAX_EVENT_RADIUS_METERS)
  }).strict(),
  z.object({ ...commonPublicFields, countingScope: z.literal('city') }).strict()
]);

export type CreateEventPayload = z.infer<typeof createEventPayloadSchema>;
export type CreateEventReply =
  | { status: 'created' | 'already_created'; event: PublicEvent }
  | { status: 'request_conflict' | 'invalid_schedule' | 'temporarily_unavailable' };
