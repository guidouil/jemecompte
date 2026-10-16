import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateGeofence } from '../../shared/geofence';
import { realEventsApproved, transaction, isEventId } from './index';
import type { EventRow } from '../events';

const configurationSchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(160),
  cityCode: z.string().trim().min(1).max(20),
  cityName: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  geofence: z.unknown(),
  countingScope: z.enum(['gathering', 'city']).default('gathering'),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  isTest: z.boolean()
}).strict().refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), { message: 'startsAt must precede endsAt.' })
  .transform((value, context) => {
    try { return { ...value, geofence: validateGeofence(value.geofence, value.countingScope) }; }
    catch { context.addIssue({ code: 'custom', path: ['geofence'], message: 'Invalid public geofence for its counting scope.' }); return z.NEVER; }
  });

export function validateEventConfiguration(value: unknown) { return configurationSchema.parse(value); }

export interface AdminActor { operator: string; reason: string; }
export function validateActor(actor: AdminActor): void {
  if (!actor.operator.trim() || actor.operator.length > 120 || !actor.reason.trim() || actor.reason.length > 1000) {
    throw new Error('Operator and reason are required and must fit the administrative limits.');
  }
}

export async function audit(client: PoolClient, actor: AdminActor, eventId: string, action: string, configuration: object = {}): Promise<void> {
  validateActor(actor);
  await client.query(`INSERT INTO admin_audit (event_id, operator, action, reason, configuration)
    VALUES ($1, $2, $3, $4, $5::jsonb)`, [eventId, actor.operator, action, actor.reason, JSON.stringify(configuration)]);
}

export async function importEventConfiguration(value: unknown, actor: AdminActor): Promise<string> {
  const config = validateEventConfiguration(value);
  validateActor(actor);
  const id = config.id ?? randomUUID();
  await transaction(async (client) => {
    const existing = await client.query<EventRow>('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows[0] && existing.rows[0].status !== 'draft') {
      throw new Error('Only drafts may be imported again. Published identity/configuration must not be silently replaced.');
    }
    if (existing.rows[0]) {
      await client.query(`UPDATE events SET slug=$2, name=$3, city_code=$4, city_name=$5, description=$6,
        geofence=$7::jsonb, starts_at=$8, ends_at=$9, is_test=$10,
        counting_scope=$11, geofence_version=geofence_version+1, metadata_version=metadata_version+1, updated_at=clock_timestamp()
        WHERE id=$1`, [id, config.slug, config.name, config.cityCode, config.cityName, config.description ?? null,
        JSON.stringify(config.geofence), config.startsAt, config.endsAt, config.isTest, config.countingScope]);
    } else {
      await client.query(`INSERT INTO events
        (id,slug,name,city_code,city_name,description,geofence,starts_at,ends_at,is_test,counting_scope)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`, [id, config.slug, config.name, config.cityCode,
        config.cityName, config.description ?? null, JSON.stringify(config.geofence), config.startsAt, config.endsAt, config.isTest, config.countingScope]);
    }
    await audit(client, actor, id, 'import_draft', { ...config, id });
  });
  return id;
}

export async function changeEventStatus(eventId: string, action: 'publish' | 'pause' | 'close', actor: AdminActor): Promise<void> {
  if (!isEventId(eventId)) throw new Error('Invalid event UUID.');
  validateActor(actor);
  await transaction(async (client) => {
    const { rows } = await client.query<EventRow>('SELECT * FROM events WHERE id=$1 FOR UPDATE', [eventId]);
    const event = rows[0];
    if (!event) throw new Error('Event not found.');
    const target = action === 'publish' ? 'published' : action === 'pause' ? 'paused' : 'closed';
    if (action === 'publish' && !event.is_test && !realEventsApproved()) {
      throw new Error('Real-event publication is disabled pending the documented legal/product decisions.');
    }
    if (event.status === target) return;
    if (action === 'publish') {
      if (!['draft', 'paused'].includes(event.status) || event.finalized_at || event.presences_purged_at) throw new Error('This event cannot be reopened.');
      const time = await client.query<{ ended: boolean }>('SELECT clock_timestamp() >= $1::timestamptz AS ended', [event.ends_at]);
      if (!time.rows[0] || time.rows[0].ended) throw new Error('An expired event cannot be published.');
    } else if (action === 'pause' && event.status !== 'published') {
      throw new Error('Only a published event may be paused.');
    } else if (action === 'close' && !['published', 'paused'].includes(event.status)) {
      throw new Error('Only a published or paused event may be closed.');
    }
    await client.query('UPDATE events SET status=$2, metadata_version=metadata_version+1, updated_at=clock_timestamp() WHERE id=$1', [eventId, target]);
    await audit(client, actor, eventId, action, { previousStatus: event.status, status: target });
  });
}
