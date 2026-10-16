import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Polygon } from 'geojson';
import { validateEventConfiguration } from '../../src/lib/server/db/admin';
import { isInsideGeofence, validateGeofence } from '../../src/lib/shared/geofence';
import { geofenceCenter } from '../../src/lib/shared/geo';
import { summarizePerimeter } from '../../src/lib/shared/perimeter-summary';

const main: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
const island: Polygon = { type: 'Polygon', coordinates: [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]] };
const commune: MultiPolygon = { type: 'MultiPolygon', coordinates: [main.coordinates, island.coordinates] };
const config = {
  id: 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a', slug: 'commune-fictive', name: 'Comptage communal fictif',
  cityCode: '00000', cityName: 'Commune fictive', isTest: true, geofence: main,
  startsAt: '2026-10-17T05:00:00Z', endsAt: '2026-10-17T17:00:00Z'
};

function detailedPolygon(vertices: number): Polygon {
  const ring = Array.from({ length: vertices }, (_, index) => [
    Number((2 + Math.cos(index * 2 * Math.PI / vertices) * 0.1).toFixed(7)),
    Number((48 + Math.sin(index * 2 * Math.PI / vertices) * 0.1).toFixed(7))
  ]);
  ring.push([...ring[0]!]);
  return { type: 'Polygon', coordinates: [ring] };
}

describe('exact whole-commune geofences', () => {
  it('keeps every part exact and tests each island instead of the enclosing bbox', () => {
    const original = JSON.stringify(commune);
    const validated = validateGeofence(commune, 'city');
    expect(validated).toEqual(commune);
    expect(JSON.stringify(commune)).toBe(original);
    expect(isInsideGeofence(0.5, 0.5, validated)).toBe(true);
    expect(isInsideGeofence(3.5, 0.5, validated)).toBe(true);
    expect(isInsideGeofence(3, 0.5, validated)).toBe(true);
    expect(isInsideGeofence(2, 0.5, validated)).toBe(false);
    expect(geofenceCenter(validated)).toEqual([2, 0.5]);
    expect(() => validateGeofence(commune)).toThrow();
  });

  it('accepts city detail beyond the historical budget without relaxing gathering limits', () => {
    const detailed = detailedPolygon(501);
    expect(validateGeofence(detailed, 'city')).toEqual(detailed);
    expect(() => validateGeofence(detailed)).toThrow(/500/);
    const extraBytes = { ...main, sourceNote: 'x'.repeat(51_200) };
    expect(validateGeofence(extraBytes, 'city')).toEqual(main);
    expect(() => validateGeofence(extraBytes)).toThrow(/50 Ko/);
    expect(() => validateGeofence({ ...main, sourceNote: 'x'.repeat(250 * 1024) }, 'city')).toThrow(/250 Ko/);
  });

  it('enforces the total vertex budget across all parts before processing intersections', () => {
    const triangle = [[[0, 0], [1, 0], [0, 1], [0, 0]]];
    expect(() => validateGeofence({ type: 'MultiPolygon', coordinates: Array.from({ length: 3_334 }, () => triangle) }, 'city'))
      .toThrow(/10000 sommets/);
  });

  it.each([
    { type: 'MultiPolygon', coordinates: [] },
    { type: 'MultiPolygon', coordinates: [[]] },
    { type: 'MultiPolygon', coordinates: [[...main.coordinates, ...island.coordinates]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [3, 3], [0, 3], [2, 0], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, Infinity], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 91], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0, 1], [1, 0], [1, 1], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[179, 0], [-179, 0], [-179, 1], [179, 0]]] },
    { type: 'GeometryCollection', geometries: [main] }
  ])('rejects unsupported or malformed city geometry without approximating it', (geometry) => {
    expect(() => validateGeofence(geometry, 'city')).toThrow();
  });

  it('rejects crossing and nested components instead of double-counting their area', () => {
    const nested: Polygon = { type: 'Polygon', coordinates: [[[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]]] };
    const crossing: Polygon = { type: 'Polygon', coordinates: [[[0.5, -1], [1.5, -1], [1.5, 0.5], [0.5, 0.5], [0.5, -1]]] };
    for (const other of [nested, crossing]) {
      expect(() => validateGeofence({ type: 'MultiPolygon', coordinates: [main.coordinates, other.coordinates] }, 'city')).toThrow();
    }
  });

  it('sums exact part areas and never describes a city boundary as a gathering radius', () => {
    const area = summarizePerimeter(main).approximateAreaSquareMeters! + summarizePerimeter(island).approximateAreaSquareMeters!;
    const summary = summarizePerimeter(commune, 'city');
    expect(summary.kind).toBe('custom');
    expect(summary.approximateRadiusMeters).toBeNull();
    expect(summary.approximateAreaSquareMeters).toBeCloseTo(area, 2);
    const detailed = detailedPolygon(501);
    expect(summarizePerimeter(detailed, 'city').approximateAreaSquareMeters).toBeGreaterThan(0);
    expect(summarizePerimeter(detailed, 'city').approximateRadiusMeters).toBeNull();
    expect(summarizePerimeter(detailed).approximateAreaSquareMeters).toBeNull();
  });

  it('defaults old administrative configurations to gathering and requires an explicit city scope for MultiPolygon', () => {
    expect(validateEventConfiguration(config).countingScope).toBe('gathering');
    expect(validateEventConfiguration({ ...config, countingScope: 'city', geofence: commune })).toMatchObject({
      countingScope: 'city', geofence: commune
    });
    expect(() => validateEventConfiguration({ ...config, geofence: commune })).toThrow();
    expect(() => validateEventConfiguration({ ...config, countingScope: 'region' })).toThrow();
    expect(() => validateEventConfiguration({ ...config, countingScope: 'city', geofence: { ...commune, coordinates: [] } })).toThrow();
  });
});
