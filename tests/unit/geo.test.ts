import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { circlePolygon, distanceMeters, geofenceCenter, type GeoPoint } from '../../src/lib/shared/geo';
import { isInsideGeofence, validateGeofence } from '../../src/lib/shared/geofence';

describe('pure public geometry helpers', () => {
  it('computes symmetric great-circle distances, including coincident and antipodal points', () => {
    const paris: GeoPoint = [2.3522, 48.8566];
    const lyon: GeoPoint = [4.8357, 45.7640];
    expect(distanceMeters(paris, paris)).toBe(0);
    expect(distanceMeters(paris, lyon)).toBeCloseTo(distanceMeters(lyon, paris), 7);
    expect(distanceMeters(paris, lyon)).toBeGreaterThan(390_000);
    expect(distanceMeters(paris, lyon)).toBeLessThan(395_000);
    expect(distanceMeters([0, 0], [180, 0])).toBeCloseTo(Math.PI * 6_371_008.8, 4);
    expect(distanceMeters([179.9, 0], [-179.9, 0])).toBeCloseTo(22_239.016, 1);
  });

  it.each([100, 200, 300, 500, 750, 1234, 10_000])('constructs a valid closed %d-meter public circle with exact-radius vertices', (radius) => {
    const center: GeoPoint = [2.363, 48.867];
    const input = [...center];
    const polygon = circlePolygon(center, radius);
    const ring = polygon.coordinates[0]!;
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring[0]).not.toBe(ring.at(-1));
    expect(validateGeofence(polygon)).toEqual(polygon);
    expect(center).toEqual(input);
    for (const vertex of ring) {
      expect(distanceMeters(center, vertex as GeoPoint)).toBeCloseTo(radius, 4);
      expect(vertex).toHaveLength(2);
    }
    expect(isInsideGeofence(...center, polygon)).toBe(true);
    expect(isInsideGeofence(...ring[0] as GeoPoint, polygon)).toBe(true);
    const outside: GeoPoint = [center[0], center[1] + radius / 100_000];
    expect(distanceMeters(center, outside)).toBeGreaterThan(radius);
    expect(isInsideGeofence(...outside, polygon)).toBe(false);
    expect(geofenceCenter(polygon)[0]).toBeCloseTo(center[0], 8);
    expect(geofenceCenter(polygon)[1]).toBeCloseTo(center[1], 8);
  });

  it('includes a point nine kilometers away but excludes one eleven kilometers away for a ten-kilometer circle', () => {
    const center: GeoPoint = [2.36325, 48.86735];
    const inside: GeoPoint = [2.36325, 48.94829];
    const outside: GeoPoint = [2.36325, 48.966275];
    const polygon = validateGeofence(circlePolygon(center, 10_000));
    expect(distanceMeters(center, inside)).toBeGreaterThan(8_950);
    expect(distanceMeters(center, inside)).toBeLessThan(9_050);
    expect(distanceMeters(center, outside)).toBeGreaterThan(10_950);
    expect(distanceMeters(center, outside)).toBeLessThan(11_050);
    expect(isInsideGeofence(...inside, polygon)).toBe(true);
    expect(isInsideGeofence(...outside, polygon)).toBe(false);
  });

  it('leaves product radius choices to the caller and preserves valid coordinate ranges near the dateline', () => {
    const polygon = circlePolygon([179.999, 0], 750);
    for (const point of polygon.coordinates[0]!) {
      expect(point[0]).toBeGreaterThanOrEqual(-180);
      expect(point[0]).toBeLessThanOrEqual(180);
      expect(point[1]).toBeGreaterThanOrEqual(-90);
      expect(point[1]).toBeLessThanOrEqual(90);
    }
    // The application's local planar geofence model deliberately excludes such a crossing.
    expect(() => validateGeofence(polygon)).toThrow(/antiméridien/);
    expect(() => geofenceCenter(polygon)).toThrow(/antiméridien/);
  });

  it('returns a bbox center without pretending it is an interior point of a concave polygon', () => {
    const concave: Polygon = { type: 'Polygon', coordinates: [
      [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]
    ] };
    expect(geofenceCenter(concave)).toEqual([2, 2]);
    expect(isInsideGeofence(2, 2, concave)).toBe(false);
  });

  it.each([
    [Infinity, 0], [0, NaN], [181, 0], [0, -91], [2, 48, 0], []
  ].map((point) => ({ point })))('rejects malformed coordinates without including their values in the error', ({ point }) => {
    expect(() => distanceMeters(point as GeoPoint, [2, 48])).toThrow('Les coordonnées géographiques sont invalides.');
    expect(() => circlePolygon(point as GeoPoint, 200)).toThrow('Les coordonnées géographiques sont invalides.');
  });

  it.each([0, -1, Infinity, NaN, Math.PI * 6_371_008.8])('rejects invalid radius %s', (radius) => {
    expect(() => circlePolygon([2, 48], radius)).toThrow(RangeError);
  });

  it('rejects polar circles that the local simple-polygon model cannot represent', () => {
    expect(() => circlePolygon([0, 90], 100)).toThrow(/pôle/);
    expect(() => circlePolygon([0, -89.9999], 100)).toThrow(/pôle/);
  });

  it('rejects empty or malformed polygons instead of producing a non-finite bbox', () => {
    expect(() => geofenceCenter({ type: 'Polygon', coordinates: [] })).toThrow(RangeError);
    expect(() => geofenceCenter({ type: 'Polygon', coordinates: [[]] })).toThrow(RangeError);
    expect(() => geofenceCenter({ type: 'Polygon', coordinates: [[[2, 48], [Infinity, 49]]] })).toThrow(RangeError);
  });
});
