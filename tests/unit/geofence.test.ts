import type { Polygon } from 'geojson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInsideGeofence, validateGeofence } from '../../src/lib/shared/geofence';
import { locateEvents } from '../../src/lib/client/geolocation';
import type { PublicEvent } from '../../src/lib/shared/types';

const polygon: Polygon = {
  type: 'Polygon',
  coordinates: [[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.9], [2.3, 48.8]]]
};

function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a', slug: 'test', name: 'Test', cityCode: '75056',
    cityName: 'Paris', description: null, geofence: polygon, geofenceVersion: 1, metadataVersion: 1,
    startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 600_000).toISOString(),
    status: 'published', integrityStatus: 'normal', protocolVersion: 1, isTest: true,
    finalizedAt: null, presencesPurgedAt: null, ...overrides
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('geofence validation and local eligibility', () => {
  it('accepts interior, boundary and vertices while rejecting outside and inverted coordinates', () => {
    expect(validateGeofence(polygon)).toEqual(polygon);
    expect(isInsideGeofence(2.35, 48.85, polygon)).toBe(true);
    expect(isInsideGeofence(2.3, 48.85, polygon)).toBe(true);
    expect(isInsideGeofence(2.3, 48.8, polygon)).toBe(true);
    expect(isInsideGeofence(2.5, 48.85, polygon)).toBe(false);
    expect(isInsideGeofence(48.85, 2.35, polygon)).toBe(false);
  });

  it.each([
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [3, 3], [0, 3], [2, 0], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, Infinity], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0, 5], [1, 0], [1, 1], [0, 0]]] },
    { type: 'Polygon', coordinates: [...polygon.coordinates, ...polygon.coordinates] },
    { type: 'MultiPolygon', coordinates: [polygon.coordinates] },
    { ...polygon, padding: 'x'.repeat(51_200) }
  ])('rejects malformed, degenerate, crossing or oversized geometry', (value) => {
    expect(() => validateGeofence(value)).toThrow();
  });

  it('enforces the vertex budget', () => {
    const ring = Array.from({ length: 501 }, (_, index) => [
      2.35 + Math.cos(index * Math.PI * 2 / 501) * 0.01,
      48.85 + Math.sin(index * Math.PI * 2 / 501) * 0.01
    ]);
    ring.push(ring[0]!);
    expect(() => validateGeofence({ type: 'Polygon', coordinates: [ring] })).toThrow(/500/);
  });

  it('requests one fresh fix and returns no location information', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { longitude: 2.35, latitude: 48.85, accuracy: 100 }, timestamp: Date.now()
    } as GeolocationPosition));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    const matching = event();
    const result = await locateEvents([matching, event({ id: 'other', status: 'paused' })]);
    expect(result.events).toEqual([matching]);
    expect(Object.keys(result).sort()).toEqual(['capturedAt', 'events']);
    expect(getCurrentPosition).toHaveBeenCalledExactlyOnceWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true, maximumAge: 0, timeout: 15_000
    });
  });

  it('rejects inaccurate fixes and handles native denial without fallback', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { longitude: 2.35, latitude: 48.85, accuracy: 101 }
    } as GeolocationPosition));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    await expect(locateEvents([event()])).rejects.toMatchObject({ code: 'inaccurate_position' });
    getCurrentPosition.mockImplementation(((_success: PositionCallback, failure: PositionErrorCallback) => {
      failure({ code: 1 } as GeolocationPositionError);
    }) as typeof getCurrentPosition);
    await expect(locateEvents([event()])).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
