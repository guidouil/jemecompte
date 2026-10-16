import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { circlePolygon, type GeoPoint } from '../../src/lib/shared/geo';
import { summarizePerimeter } from '../../src/lib/shared/perimeter-summary';

describe('display-only public perimeter summary', () => {
  it.each([100, 500, 750, 1_234, 10_000])('recognizes the published %d-meter circle without changing it', (radius) => {
    const polygon = circlePolygon([2.36325, 48.86735], radius);
    const original = JSON.stringify(polygon);
    const result = summarizePerimeter(polygon);
    expect(result.kind).toBe('circle');
    expect(result.approximateRadiusMeters).toBeCloseTo(radius, 4);
    expect(result.approximateAreaSquareMeters).toBeGreaterThan(Math.PI * radius ** 2 * 0.995);
    expect(result.approximateAreaSquareMeters).toBeLessThan(Math.PI * radius ** 2 * 1.005);
    expect(JSON.stringify(polygon)).toBe(original);
  });

  it('keeps a square personalized even though all corners have the same distance to the center', () => {
    const polygon: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    const result = summarizePerimeter(polygon);
    expect(result.kind).toBe('custom');
    expect(result.approximateRadiusMeters).toBeNull();
    expect(result.approximateAreaSquareMeters).toBeCloseTo(12_363_718_145.18, -2);
    const reversed: Polygon = { type: 'Polygon', coordinates: [polygon.coordinates[0]!.slice().reverse()] };
    expect(summarizePerimeter(reversed).approximateAreaSquareMeters).toBeCloseTo(result.approximateAreaSquareMeters!, 2);
  });

  it('does not mistake an ellipse or irregular angular samples for a circle', () => {
    const polygon = circlePolygon([2.36, 48.86], 500);
    const ellipse: Polygon = { type: 'Polygon', coordinates: [polygon.coordinates[0]!.map((point) => [2.36 + (point[0]! - 2.36) * 2, point[1]!])] };
    expect(summarizePerimeter(ellipse).kind).toBe('custom');
    const ring = polygon.coordinates[0]!.slice(0, -1);
    const irregular = [...ring.slice(0, 10), ...ring.slice(11), ring[0]!] as GeoPoint[];
    expect(summarizePerimeter({ type: 'Polygon', coordinates: [irregular] }).kind).toBe('custom');
  });

  it('estimates a concave custom polygon without claiming its bbox center belongs to the zone', () => {
    const polygon: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 0.5], [0.5, 0.5], [0.5, 2], [0, 2], [0, 0]]] };
    const result = summarizePerimeter(polygon);
    expect(result.kind).toBe('custom');
    expect(result.approximateRadiusMeters).toBeNull();
    expect(result.approximateAreaSquareMeters).toBeGreaterThan(0);
  });

  it.each([
    { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [[]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, Infinity], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[179, 0], [-179, 0], [-179, 1], [179, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.1, 0.1], [0.2, 0.1], [0.1, 0.2], [0.1, 0.1]]] }
  ] as Polygon[])('uses a neutral summary when a simple supported area cannot be estimated', (polygon) => {
    expect(summarizePerimeter(polygon)).toEqual({ kind: 'custom', approximateRadiusMeters: null, approximateAreaSquareMeters: null });
  });
});
