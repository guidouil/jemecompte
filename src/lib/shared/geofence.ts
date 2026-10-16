import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import kinks from '@turf/kinks';
import type { Polygon } from 'geojson';
import type { CountingScope, EventGeofence } from './types';

export const MAX_GEOFENCE_VERTICES = 500;
export const MAX_GEOFENCE_BYTES = 50 * 1024;
export const MAX_CITY_GEOFENCE_VERTICES = 10_000;
export const MAX_CITY_GEOFENCE_BYTES = 250 * 1024;

export class GeofenceError extends Error {
  constructor(message = 'Le périmètre géographique est invalide.') {
    super(message);
    this.name = 'GeofenceError';
  }
}

/** Administrative validation. Only the point test below is used by the participant bundle. */
export function validateGeofence(value: unknown, scope?: 'gathering'): Polygon;
export function validateGeofence(value: unknown, scope: CountingScope): EventGeofence;
export function validateGeofence(value: unknown, scope: CountingScope = 'gathering'): EventGeofence {
  if (scope !== 'gathering' && scope !== 'city') throw new GeofenceError('La portée du comptage est invalide.');
  const maxBytes = scope === 'city' ? MAX_CITY_GEOFENCE_BYTES : MAX_GEOFENCE_BYTES;
  const maxVertices = scope === 'city' ? MAX_CITY_GEOFENCE_VERTICES : MAX_GEOFENCE_VERTICES;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new GeofenceError();
  }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new GeofenceError(`Le périmètre dépasse la taille maximale de ${maxBytes / 1024} Ko.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GeofenceError();
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'Polygon' && !(scope === 'city' && candidate.type === 'MultiPolygon')) {
    throw new GeofenceError('Un polygone simple sans trou est requis.');
  }
  if (!Array.isArray(candidate.coordinates) || !candidate.coordinates.length) throw new GeofenceError();
  const parts = candidate.type === 'Polygon' ? [candidate.coordinates] : candidate.coordinates;
  let vertices = 0;
  for (const part of parts) {
    if (!Array.isArray(part) || part.length !== 1 || !Array.isArray(part[0])) {
      throw new GeofenceError('Chaque polygone doit comporter un seul anneau, sans trou.');
    }
    vertices += part[0].length - 1;
    if (vertices > maxVertices) throw new GeofenceError(`Le périmètre dépasse la limite totale de ${maxVertices} sommets.`);
  }
  const polygons: Polygon[] = parts.map((part) => ({ type: 'Polygon', coordinates: [validateRing(part[0], maxVertices)] }));
  const geometry: EventGeofence = candidate.type === 'Polygon' ? polygons[0]! : {
    type: 'MultiPolygon', coordinates: polygons.map((polygon) => polygon.coordinates)
  };
  if (kinks(geometry).features.length > 0) {
    throw new GeofenceError('Le périmètre ne doit pas se croiser lui-même.');
  }
  // Nested components overlap without crossing their edges, and are not a valid MultiPolygon.
  for (let first = 0; first < polygons.length; first++) {
    for (let second = first + 1; second < polygons.length; second++) {
      const a = polygons[first]!;
      const b = polygons[second]!;
      if (booleanPointInPolygon(a.coordinates[0]![0]!, b, { ignoreBoundary: true }) ||
          booleanPointInPolygon(b.coordinates[0]![0]!, a, { ignoreBoundary: true })) {
        throw new GeofenceError('Les parties du périmètre ne doivent pas se recouvrir.');
      }
    }
  }
  return geometry;
}

function validateRing(value: unknown[], maxVertices: number): [number, number][] {
  const ring: [number, number][] = [];
  for (const coordinate of value) {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length !== 2 ||
      !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]) ||
      Math.abs(coordinate[0]) > 180 ||
      Math.abs(coordinate[1]) > 90
    ) {
      throw new GeofenceError('Les coordonnées doivent être des couples longitude, latitude valides.');
    }
    ring.push([coordinate[0], coordinate[1]]);
  }
  if (ring.length < 4 || ring.length - 1 > maxVertices) {
    throw new GeofenceError(`Le polygone doit comporter de 3 à ${maxVertices} sommets et un anneau fermé.`);
  }
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new GeofenceError('L’anneau du polygone doit être fermé.');
  }
  const vertices = new Set<string>();
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const point = ring[index]!;
    const next = ring[index + 1]!;
    const encoded = `${point[0]},${point[1]}`;
    if (vertices.has(encoded)) throw new GeofenceError('Le polygone contient un sommet répété.');
    vertices.add(encoded);
    if (Math.abs(next[0] - point[0]) > 180) {
      throw new GeofenceError('La traversée de l’antiméridien n’est pas prise en charge.');
    }
    // Translate before the shoelace calculation to avoid subtracting large, nearly equal products.
    twiceArea +=
      (point[0] - first[0]) * (next[1] - first[1]) -
      (next[0] - first[0]) * (point[1] - first[1]);
  }
  if (Math.abs(twiceArea) < 1e-12) throw new GeofenceError('Le polygone est dégénéré.');
  return ring;
}

/** Coordinates remain local; GeoJSON expects longitude before latitude. Boundary is included. */
export function isInsideGeofence(longitude: number, latitude: number, polygon: EventGeofence): boolean {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  return booleanPointInPolygon([longitude, latitude], polygon, { ignoreBoundary: false });
}
