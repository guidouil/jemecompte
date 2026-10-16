import { z } from 'zod';

export const eventIdSchema = z.uuid().transform((value) => value.toLowerCase());
// 32 bytes encoded without padding. Two unused bits in the last character must be zero.
export const anonymousEventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const participationPayloadSchema = z.object({
  anonymousEventId: anonymousEventIdSchema,
  geofenceVersion: z.number().int().positive().max(2_147_483_647),
  protocolVersion: z.literal(1),
  insideZone: z.literal(true)
}).strict();
export const presenceStatusPayloadSchema = z.object({
  anonymousEventId: anonymousEventIdSchema
}).strict();

const decimal = z.string().regex(/^(0|[1-9]\d{0,30})$/);
export const counterSnapshotSchema = z.object({
  eventId: eventIdSchema,
  total: decimal,
  revision: decimal,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nationalTotal: decimal,
  nationalRevision: decimal,
  cityTotal: decimal,
  cityRevision: decimal,
  epoch: z.string().regex(/^[1-9]\d{0,30}$/),
  serverTime: z.iso.datetime({ offset: true }),
  eventStatus: z.enum(['draft', 'published', 'paused', 'closed', 'cancelled']),
  integrityStatus: z.enum(['normal', 'anomaly', 'suspended']),
  metadataVersion: z.number().int().positive(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true })
}).strict();
