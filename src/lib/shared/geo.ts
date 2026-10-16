import type { Polygon } from 'geojson';

/** WGS84 coordinates, always longitude before latitude. No location is collected or retained here. */
export type GeoPoint = [number, number];

const EARTH_RADIUS_METERS = 6_371_008.8;
const CIRCLE_VERTICES = 64;
const radians = (degrees: number): number => degrees * Math.PI / 180;
const degrees = (angle: number): number => angle * 180 / Math.PI;

function assertPoint(value: GeoPoint): void {
  if (
    !Array.isArray(value) || value.length !== 2 ||
    !Number.isFinite(value[0]) || !Number.isFinite(value[1]) ||
    Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90
  ) {
    // Do not echo coordinates into an error that could subsequently be logged.
    throw new RangeError('Les coordonnées géographiques sont invalides.');
  }
}

/** Shortest great-circle distance on a mean-radius sphere; sufficient for local discovery. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  assertPoint(a);
  assertPoint(b);
  const latitudeA = radians(a[1]);
  const latitudeB = radians(b[1]);
  const deltaLatitude = latitudeB - latitudeA;
  const deltaLongitude = radians(b[0] - a[0]);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLongitude / 2) ** 2;
  // Rounding near antipodal points can otherwise produce sqrt(negative) or asin(>1).
  const bounded = Math.max(0, Math.min(1, haversine));
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

/**
 * Inscribed 64-sided approximation of a public circle, using spherical destination points.
 * The caller supplies an explicitly chosen PUBLIC center, never an automatic participant fix.
 * Product radius choices and accepted geographic regions belong to request validation.
 * Existing geofence validation still rejects unsupported antimeridian-crossing geometries.
 */
export function circlePolygon(center: GeoPoint, radiusMeters: number): Polygon {
  assertPoint(center);
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters >= Math.PI * EARTH_RADIUS_METERS) {
    throw new RangeError('Le rayon doit être positif et inférieur à une demi-circonférence terrestre.');
  }
  const latitude = radians(center[1]);
  const longitude = radians(center[0]);
  const angularRadius = radiusMeters / EARTH_RADIUS_METERS;
  if (Math.abs(latitude) + angularRadius >= Math.PI / 2) {
    throw new RangeError('Les cercles contenant un pôle ne sont pas pris en charge.');
  }
  const ring: GeoPoint[] = [];
  for (let index = 0; index < CIRCLE_VERTICES; index += 1) {
    // Negative bearings produce an exterior ring with counterclockwise winding.
    const bearing = -index * 2 * Math.PI / CIRCLE_VERTICES;
    const sinDestinationLatitude = Math.sin(latitude) * Math.cos(angularRadius) +
      Math.cos(latitude) * Math.sin(angularRadius) * Math.cos(bearing);
    const destinationLatitude = Math.asin(Math.max(-1, Math.min(1, sinDestinationLatitude)));
    const destinationLongitude = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(latitude),
      Math.cos(angularRadius) - Math.sin(latitude) * Math.sin(destinationLatitude)
    );
    const normalizedLongitude = (degrees(destinationLongitude) + 540) % 360 - 180;
    ring.push([normalizedLongitude, degrees(destinationLatitude)]);
  }
  ring.push([...ring[0]!] as GeoPoint);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Bounding-box midpoint for already validated local event polygons; not a participant position. */
export function geofenceCenter(polygon: Polygon): GeoPoint {
  if (!polygon || polygon.type !== 'Polygon' || !Array.isArray(polygon.coordinates) || !polygon.coordinates.length) {
    throw new RangeError('Le périmètre géographique est invalide.');
  }
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const ring of polygon.coordinates) {
    if (!Array.isArray(ring) || !ring.length) throw new RangeError('Le périmètre géographique est invalide.');
    for (const position of ring) {
      assertPoint(position as GeoPoint);
      const [longitude, latitude] = position as GeoPoint;
      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
  }
  if (east - west > 180) {
    throw new RangeError('Les périmètres traversant l’antiméridien ne sont pas pris en charge.');
  }
  return [(west + east) / 2, (south + north) / 2];
}
