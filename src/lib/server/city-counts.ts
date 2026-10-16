import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { audit, validateActor, validateEventConfiguration, type AdminActor } from './db/admin';
import { realEventsApproved, transaction } from './db';
import type { EventRow } from './events';

export class CityCountsError extends Error {}
export type CityCountConfiguration = ReturnType<typeof validateEventConfiguration> & {
  id: string; countingScope: 'city'; isTest: false;
};

export function geometrySha256(geometry: { type: string; coordinates: unknown }): string {
  return createHash('sha256').update(JSON.stringify({ type: geometry.type, coordinates: geometry.coordinates })).digest('hex');
}

/** Pure validation: this function never obtains a database connection. */
export function validateCityCountsBatch(value: unknown): CityCountConfiguration[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new CityCountsError('Le manifeste doit contenir de 1 à 100 comptages de ville.');
  }
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const codes = new Set<string>();
  return value.map((candidate) => {
    let config: ReturnType<typeof validateEventConfiguration>;
    try { config = validateEventConfiguration(candidate); }
    catch { throw new CityCountsError('Une configuration de ville est invalide : vérifier champs, dates et contour administratif.'); }
    if (!config.id || config.countingScope !== 'city' || config.isTest !== false) {
      throw new CityCountsError('Chaque ville doit fournir un UUID stable, countingScope city et isTest false.');
    }
    // PostgreSQL returns canonical lowercase UUIDs. Normalize before comparison and replay.
    config.id = config.id.toLowerCase();
    if (ids.has(config.id) || slugs.has(config.slug) || codes.has(config.cityCode)) {
      throw new CityCountsError('Le manifeste contient un UUID, un lien ou une commune en double.');
    }
    ids.add(config.id); slugs.add(config.slug); codes.add(config.cityCode);
    return config as CityCountConfiguration;
  });
}

const sourcesSchema = z.object({ communes: z.array(z.object({
  id: z.string().uuid(), code: z.string(), geometrySha256: z.string().regex(/^[a-f0-9]{64}$/)
}).passthrough()) }).passthrough();

/** Verify that the reviewed public provenance still matches every exact geometry in the manifest. */
export function verifyCityCountSources(configs: CityCountConfiguration[], value: unknown): void {
  const sources = sourcesSchema.safeParse(value);
  if (!sources.success || sources.data.communes.length !== configs.length) throw new CityCountsError('Les sources du manifeste sont absentes ou invalides.');
  const indexed = new Map(sources.data.communes.map((entry) => [entry.id.toLowerCase(), entry]));
  if (indexed.size !== configs.length) throw new CityCountsError('Les sources contiennent des UUID en double.');
  for (const config of configs) {
    const source = indexed.get(config.id);
    if (!source || source.code !== config.cityCode || source.geometrySha256 !== geometrySha256(config.geofence)) {
      throw new CityCountsError('Une empreinte de contour ne correspond plus aux sources publiques relues.');
    }
  }
}

function sameConfiguration(row: EventRow, config: CityCountConfiguration): boolean {
  return row.id === config.id && row.slug === config.slug && row.name === config.name &&
    row.city_code === config.cityCode && row.city_name === config.cityName &&
    row.description === (config.description ?? null) && row.counting_scope === 'city' &&
    row.is_test === false && row.creation_source === 'team' && row.creation_request_hash === null &&
    new Date(row.starts_at).getTime() === Date.parse(config.startsAt) &&
    new Date(row.ends_at).getTime() === Date.parse(config.endsAt) &&
    isDeepStrictEqual(row.geofence, config.geofence);
}

export interface CityCountsResult {
  action: 'apply' | 'publish';
  created: string[];
  published: string[];
  skipped: string[];
}

/** Administrative batch only: immutable identities/configurations, one atomic transaction, no presences. */
export async function executeCityCountsBatch(value: unknown, action: 'apply' | 'publish', actor: AdminActor): Promise<CityCountsResult> {
  if (action !== 'apply' && action !== 'publish') throw new CityCountsError('Une action administrative explicite est requise.');
  const configs = validateCityCountsBatch(value);
  try { validateActor(actor); }
  catch { throw new CityCountsError('Un opérateur et un motif administratifs valides sont requis.'); }
  if (action === 'publish' && !realEventsApproved()) {
    throw new CityCountsError('La publication réelle est désactivée. Cette commande ne modifie jamais REAL_EVENTS_APPROVED.');
  }
  return transaction(async (client) => {
    // Serialize these batches. Unique constraints still reject collisions with other administrative writers.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jemecompte:city-counts'))");
    const existing = await client.query<EventRow>(`SELECT * FROM events
      WHERE id=ANY($1::uuid[]) OR slug=ANY($2::text[]) FOR UPDATE`, [configs.map((config) => config.id), configs.map((config) => config.slug)]);
    const byId = new Map(existing.rows.map((row) => [row.id, row]));
    const bySlug = new Map(existing.rows.map((row) => [row.slug, row]));
    const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = clock.rows[0]?.now.getTime();
    if (now === undefined) throw new CityCountsError('L’heure de la base ne peut pas être vérifiée.');
    // Check the entire batch before its first write; any later database error also rolls everything back.
    for (const config of configs) {
      const row = byId.get(config.id);
      const slugOwner = bySlug.get(config.slug);
      if (slugOwner && slugOwner.id !== config.id) throw new CityCountsError('Un lien du manifeste appartient déjà à un autre comptage.');
      if (!row) {
        if (action === 'publish') throw new CityCountsError('Importer tous les brouillons avant de demander une publication séparée.');
        continue;
      }
      if (row.is_test !== config.isTest) throw new CityCountsError('Un UUID existe déjà dans le mode opposé. Aucun comptage n’a été modifié.');
      if (!sameConfiguration(row, config)) throw new CityCountsError('Un comptage existant diffère du manifeste. Aucune configuration ne sera remplacée.');
      if (!['draft', 'published'].includes(row.status) || row.finalized_at || row.presences_purged_at || row.integrity_status !== 'normal') {
        throw new CityCountsError('Un comptage suspendu, clôturé, finalisé ou anormal empêche le traitement du lot.');
      }
      if (action === 'publish' && row.status === 'draft' && Date.parse(config.endsAt) <= now) {
        throw new CityCountsError('Un brouillon expiré ne peut pas être publié.');
      }
    }
    const result: CityCountsResult = { action, created: [], published: [], skipped: [] };
    for (const config of configs) {
      const row = byId.get(config.id);
      if (action === 'apply') {
        if (row) { result.skipped.push(config.id); continue; }
        await client.query(`INSERT INTO events
          (id,slug,name,city_code,city_name,description,counting_scope,geofence,starts_at,ends_at,is_test,status)
          VALUES ($1,$2,$3,$4,$5,$6,'city',$7::jsonb,$8,$9,false,'draft')`, [
          config.id, config.slug, config.name, config.cityCode, config.cityName, config.description ?? null,
          JSON.stringify(config.geofence), config.startsAt, config.endsAt
        ]);
        await audit(client, actor, config.id, 'city_batch_import', {
          slug: config.slug, countingScope: 'city', isTest: false,
          startsAt: config.startsAt, endsAt: config.endsAt, geometrySha256: geometrySha256(config.geofence)
        });
        result.created.push(config.id);
      } else {
        if (row!.status === 'published') { result.skipped.push(config.id); continue; }
        // Recheck the approval flag just before writes; this operation never changes it.
        if (!realEventsApproved()) throw new CityCountsError('La publication réelle est désactivée.');
        await client.query(`UPDATE events SET status='published', metadata_version=metadata_version+1,
          updated_at=clock_timestamp() WHERE id=$1`, [config.id]);
        await audit(client, actor, config.id, 'city_batch_publish', { previousStatus: 'draft', status: 'published' });
        result.published.push(config.id);
      }
    }
    return result;
  });
}
