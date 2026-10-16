import { distanceMeters, geofenceCenter } from '../shared/geo';
import type { PublicEvent } from '../shared/types';

export type DiscoveryPeriod = 'all' | 'current' | 'upcoming';
export type DiscoveryPosition = [longitude: number, latitude: number];

export interface DiscoveryOptions {
  query: string;
  period: DiscoveryPeriod;
  now: number;
  position: DiscoveryPosition | null;
  radiusKm: number;
}

export interface DiscoveredEvent {
  event: PublicEvent;
  period: 'current' | 'upcoming';
  distance: number | null;
}

export function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr-FR')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[’'\-]/g, ' ').trim();
}

/** Filters the supplied public catalogue entirely in memory. */
export function discoverEvents(events: PublicEvent[], options: DiscoveryOptions): DiscoveredEvent[] {
  const tokens = normalizeSearch(options.query).split(/\s+/).filter(Boolean);
  const results: DiscoveredEvent[] = [];

  for (const event of events) {
    if (event.status !== 'published' && event.status !== 'paused') continue;
    const startsAt = Date.parse(event.startsAt);
    const endsAt = Date.parse(event.endsAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= options.now) continue;
    const period = startsAt > options.now ? 'upcoming' : 'current';
    if (options.period !== 'all' && options.period !== period) continue;
    const searchable = normalizeSearch(`${event.name} ${event.cityName}`);
    if (!tokens.every((token) => searchable.includes(token))) continue;

    let distance: number | null = null;
    if (options.position) {
      try {
        distance = distanceMeters(options.position, geofenceCenter(event.geofence));
      } catch {
        // A malformed perimeter cannot supply a meaningful proximity result.
        continue;
      }
      if (!Number.isFinite(distance) || distance < 0 || distance > options.radiusKm * 1_000) continue;
    }
    results.push({ event, period, distance });
  }

  return results.sort((a, b) => {
    if (a.distance !== null && b.distance !== null && a.distance !== b.distance) return a.distance - b.distance;
    if (a.period !== b.period) return a.period === 'current' ? -1 : 1;
    const byStart = Date.parse(a.event.startsAt) - Date.parse(b.event.startsAt);
    return byStart || a.event.cityName.localeCompare(b.event.cityName, 'fr', { sensitivity: 'base' }) ||
      a.event.name.localeCompare(b.event.name, 'fr', { sensitivity: 'base' }) || a.event.id.localeCompare(b.event.id);
  });
}

export function approximateDistance(meters: number): string {
  if (meters < 1_000) return 'À moins de 1 km';
  return `À environ ${new Intl.NumberFormat('fr-FR').format(Math.round(meters / 1_000))} km`;
}

export class DiscoveryLocationError extends Error {
  constructor(public readonly code: 'unsupported' | 'denied' | 'timeout' | 'unavailable') {
    super(code === 'unsupported' ? 'Ce navigateur ne permet pas la recherche autour de vous. Cherchez par nom ou par ville.' :
      code === 'denied' ? 'La localisation est refusée. Vous pouvez toujours chercher par nom ou par ville.' :
      code === 'timeout' ? 'La position n’est pas arrivée à temps. Réessayez ou cherchez par ville.' :
      'Votre position n’est pas disponible. Réessayez ou cherchez par ville.');
    this.name = 'DiscoveryLocationError';
  }
}

/** Called only after the explicit proximity action; no watching, networking or persistence. */
export function locateForDiscovery(): Promise<DiscoveryPosition> {
  const geolocation = globalThis.navigator?.geolocation;
  if (!geolocation) return Promise.reject(new DiscoveryLocationError('unsupported'));
  return new Promise((resolve, reject) => {
    try {
      geolocation.getCurrentPosition((position) => {
        const { longitude, latitude } = position.coords;
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
          longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
          reject(new DiscoveryLocationError('unavailable'));
          return;
        }
        resolve([longitude, latitude]);
      }, (error) => {
        reject(new DiscoveryLocationError(error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable'));
      }, { enableHighAccuracy: false, maximumAge: 0, timeout: 10_000 });
    } catch {
      reject(new DiscoveryLocationError('unavailable'));
    }
  });
}
