import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, check, customType, date, integer, jsonb,
  pgTable, primaryKey, timestamp, uuid, varchar
} from 'drizzle-orm/pg-core';
import type { CountingScope, EventGeofence } from '../../shared/types';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const events = pgTable('events', {
  id: uuid('id').primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 160 }).notNull(),
  cityCode: varchar('city_code', { length: 20 }).notNull(),
  cityName: varchar('city_name', { length: 120 }).notNull(),
  description: varchar('description', { length: 2000 }),
  geofence: jsonb('geofence').$type<EventGeofence>().notNull(),
  countingScope: varchar('counting_scope', { length: 16 }).$type<CountingScope>().notNull().default('gathering'),
  geofenceVersion: integer('geofence_version').notNull().default(1),
  metadataVersion: integer('metadata_version').notNull().default(1),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  integrityStatus: varchar('integrity_status', { length: 16 }).notNull().default('normal'),
  protocolVersion: integer('protocol_version').notNull().default(1),
  isTest: boolean('is_test').notNull(),
  creationSource: varchar('creation_source', { length: 16 }).notNull().default('team'),
  creationRequestHash: bytea('creation_request_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  presencesPurgedAt: timestamp('presences_purged_at', { withTimezone: true })
}, (table) => [
  check('events_dates_check', sql`${table.startsAt} < ${table.endsAt}`),
  check('events_slug_check', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  check('events_name_check', sql`length(${table.name}) > 0`),
  check('events_city_code_check', sql`length(${table.cityCode}) > 0`),
  check('events_city_name_check', sql`length(${table.cityName}) > 0`),
  check('events_status_check', sql`${table.status} IN ('draft','published','paused','closed','cancelled')`),
  check('events_integrity_check', sql`${table.integrityStatus} IN ('normal','anomaly','suspended')`),
  check('events_versions_check', sql`${table.geofenceVersion} > 0 AND ${table.metadataVersion} > 0 AND ${table.protocolVersion} = 1`),
  check('events_counting_scope_check', sql`${table.countingScope} IN ('gathering','city')`),
  check('events_polygon_check', sql`COALESCE(jsonb_typeof(${table.geofence}) = 'object' AND jsonb_typeof(${table.geofence}->'coordinates') = 'array' AND ((${table.countingScope} = 'gathering' AND ${table.geofence}->>'type' = 'Polygon') OR (${table.countingScope} = 'city' AND ${table.geofence}->>'type' IN ('Polygon','MultiPolygon'))), false)`),
  check('events_creation_source_check', sql`${table.creationSource} IN ('team','community')`),
  check('events_creation_hash_check', sql`(${table.creationSource} = 'team' AND ${table.creationRequestHash} IS NULL) OR (${table.creationSource} = 'community' AND ${table.creationRequestHash} IS NOT NULL AND octet_length(${table.creationRequestHash}) = 32)`)
]);

export const presences = pgTable('presences', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'restrict' }),
  anonymousEventId: bytea('anonymous_event_id').notNull(),
  countingDay: date('counting_day', { mode: 'string' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.eventId, table.anonymousEventId] }),
  check('presences_identifier_length', sql`octet_length(${table.anonymousEventId}) = 32`)
]);

export const eventCounters = pgTable('event_counters', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'restrict' }),
  countingDay: date('counting_day', { mode: 'string' }).notNull(),
  count: bigint('count', { mode: 'bigint' }).notNull().default(0n),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n)
}, (table) => [
  primaryKey({ columns: [table.eventId, table.countingDay] }),
  check('event_counters_nonnegative', sql`${table.count} >= 0 AND ${table.revision} >= 0`)
]);

export const supports = pgTable('supports', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'restrict' }),
  anonymousEventId: bytea('anonymous_event_id').notNull(),
  countingDay: date('counting_day', { mode: 'string' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.eventId, table.anonymousEventId] }),
  check('supports_identifier_length', sql`octet_length(${table.anonymousEventId}) = 32`)
]);

export const supportCounters = pgTable('support_counters', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'restrict' }),
  countingDay: date('counting_day', { mode: 'string' }).notNull(),
  count: bigint('count', { mode: 'bigint' }).notNull().default(0n),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n)
}, (table) => [
  primaryKey({ columns: [table.eventId, table.countingDay] }),
  check('support_counters_nonnegative', sql`${table.count} >= 0 AND ${table.revision} >= 0`)
]);

export const dailySupportClaims = pgTable('daily_support_claims', {
  countingDay: date('counting_day', { mode: 'string' }).notNull(),
  anonymousDayId: bytea('anonymous_day_id').notNull()
}, (table) => [
  primaryKey({ columns: [table.countingDay, table.anonymousDayId] }),
  check('daily_support_claims_identifier_length', sql`octet_length(${table.anonymousDayId}) = 32`)
]);

export const adminAudit = pgTable('admin_audit', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'restrict' }),
  operator: varchar('operator', { length: 120 }).notNull(),
  action: varchar('action', { length: 40 }).notNull(),
  reason: varchar('reason', { length: 1000 }).notNull(),
  configuration: jsonb('configuration').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
