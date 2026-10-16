import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import kinks from '@turf/kinks';
import type { Polygon } from 'geojson';

export const MAX_GEOFENCE_VERTICES = 500;
export const MAX_GEOFENCE_BYTES = 50 * 1024;

export class GeofenceError extends Error {
  constructor(message = 'Le périmètre géographique est invalide.') {
    super(message);
    this.name = 'GeofenceError';
  }
}

/** Administrative validation. Only the point test below is used by the participant bundle. */
export function validateGeofence(value: unknown): Polygon {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new GeofenceError();
  }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_GEOFENCE_BYTES) {
    throw new GeofenceError('Le périmètre dépasse la taille maximale de 50 Ko.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GeofenceError();
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== 'Polygon' ||
    !Array.isArray(candidate.coordinates) ||
    candidate.coordinates.length !== 1 ||
    !Array.isArray(candidate.coordinates[0])
  ) {
    throw new GeofenceError('Un polygone simple sans trou est requis.');
  }
  const ring: [number, number][] = [];
  for (const coordinate of candidate.coordinates[0]) {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length !== 2 ||
      !coordinate.every((part) => typeof part === 'number' && Number.isFinite(part)) ||
      Math.abs(coordinate[0]) > 180 ||
      Math.abs(coordinate[1]) > 90
    ) {
      throw new GeofenceError('Les coordonnées doivent être des couples longitude, latitude valides.');
    }
    ring.push([coordinate[0], coordinate[1]]);
  }
  if (ring.length < 4 || ring.length - 1 > MAX_GEOFENCE_VERTICES) {
    throw new GeofenceError('Le polygone doit comporter de 3 à 500 sommets et un anneau fermé.');
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
  const polygon: Polygon = { type: 'Polygon', coordinates: [ring] };
  if (kinks(polygon).features.length > 0) {
    throw new GeofenceError('Le polygone ne doit pas se croiser lui-même.');
  }
  return polygon;
}

/** Coordinates remain local; GeoJSON expects longitude before latitude. Boundary is included. */
export function isInsideGeofence(longitude: number, latitude: number, polygon: Polygon): boolean {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  return booleanPointInPolygon([longitude, latitude], polygon, { ignoreBoundary: false });
}
