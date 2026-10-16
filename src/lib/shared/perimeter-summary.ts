import type { Polygon } from 'geojson';
import { distanceMeters, geofenceCenter, type GeoPoint } from './geo';

export interface PerimeterSummary {
  kind: 'circle' | 'custom';
  approximateRadiusMeters: number | null;
  approximateAreaSquareMeters: number | null;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const radians = (value: number) => value * Math.PI / 180;
const emptySummary = (): PerimeterSummary => ({ kind: 'custom', approximateRadiusMeters: null, approximateAreaSquareMeters: null });

/** A display-only estimate of an already public perimeter; never changes its geometry. */
export function summarizePerimeter(polygon: Polygon): PerimeterSummary {
  if (polygon?.type !== 'Polygon' || polygon.coordinates?.length !== 1) return emptySummary();
  const ring = polygon.coordinates[0];
  if (!ring || ring.length < 4 || ring.length > 501) return emptySummary();
  if (ring.some((point) => point.length !== 2 || !point.every(Number.isFinite) ||
    Math.abs(point[0]!) > 180 || Math.abs(point[1]!) > 90)) return emptySummary();
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) return emptySummary();

  let center: GeoPoint;
  try { center = geofenceCenter(polygon); } catch { return emptySummary(); }

  let areaSum = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const point = ring[index]!;
    const next = ring[index + 1]!;
    if (Math.abs(next[0]! - point[0]!) > 180) return emptySummary();
    // Spherical trapezoids. Translating sine values avoids cancellation for small zones.
    areaSum += radians(next[0]! - point[0]!) *
      (Math.sin(radians(point[1]!)) + Math.sin(radians(next[1]!)) - 2 * Math.sin(radians(first[1]!)));
  }
  const area = Math.abs(areaSum) * EARTH_RADIUS_METERS ** 2 / 2;
  if (!Number.isFinite(area) || area <= 0) return emptySummary();
  const summary: PerimeterSummary = { kind: 'custom', approximateRadiusMeters: null, approximateAreaSquareMeters: area };
  const vertices = ring.slice(0, -1) as GeoPoint[];
  // A few equidistant corners (a square, for example) do not make a recognizable circle.
  if (vertices.length < 24) return summary;
  const distances = vertices.map((point) => distanceMeters(center, point));
  const radius = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  const tolerance = Math.max(0.5, radius * 0.005);
  if (radius <= 0 || distances.some((value) => Math.abs(value - radius) > tolerance)) return summary;

  const centerLatitude = radians(center[1]);
  const bearings = vertices.map((point) => {
    const latitude = radians(point[1]);
    const longitudeDelta = radians(point[0] - center[0]);
    return (Math.atan2(Math.sin(longitudeDelta) * Math.cos(latitude),
      Math.cos(centerLatitude) * Math.sin(latitude) - Math.sin(centerLatitude) * Math.cos(latitude) * Math.cos(longitudeDelta)) + 2 * Math.PI) % (2 * Math.PI);
  }).sort((a, b) => a - b);
  const expectedGap = 2 * Math.PI / bearings.length;
  for (let index = 0; index < bearings.length; index++) {
    const next = index + 1 < bearings.length ? bearings[index + 1]! : bearings[0]! + 2 * Math.PI;
    if (Math.abs(next - bearings[index]! - expectedGap) > expectedGap * 0.02) return summary;
  }
  return { ...summary, kind: 'circle', approximateRadiusMeters: radius };
}
