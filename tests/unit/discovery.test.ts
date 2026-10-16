import type { Polygon } from 'geojson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approximateDistance, discoverEvents, locateForDiscovery, normalizeSearch } from '../../src/lib/client/discovery';
import type { DiscoveryOptions } from '../../src/lib/client/discovery';
import type { PublicEvent } from '../../src/lib/shared/types';

const now = Date.parse('2026-10-16T10:00:00Z');
const polygon: Polygon = { type: 'Polygon', coordinates: [[[2.35, 48.85], [2.36, 48.85], [2.36, 48.86], [2.35, 48.86], [2.35, 48.85]]] };
const options: DiscoveryOptions = { query: '', period: 'all', now, position: null, radiusKm: 25 };

function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return { id: 'one', slug: 'test', name: 'République', cityCode: '75056', cityName: 'Paris',
    description: null, geofence: polygon, geofenceVersion: 1, metadataVersion: 1,
    startsAt: '2026-10-16T09:00:00Z', endsAt: '2026-10-16T11:00:00Z', status: 'published',
    integrityStatus: 'normal', protocolVersion: 1, isTest: true, finalizedAt: null, presencesPurgedAt: null,
    ...overrides };
}

afterEach(() => vi.unstubAllGlobals());

describe('public event discovery', () => {
  it('matches accents, case, ligatures and name/city terms in either order', () => {
    expect(normalizeSearch('  CŒUR — RÉPUBLIQUE  ')).toContain('coeur');
    const matching = event({ name: 'Cœur de République', cityName: 'Saint-Étienne' });
    expect(discoverEvents([matching], { ...options, query: 'SAINT etienne coeur republique' })).toHaveLength(1);
    expect(discoverEvents([matching], { ...options, query: 'Lyon' })).toEqual([]);
  });

  it('handles start/end boundaries, hides closed/cancelled/draft and keeps paused events discoverable', () => {
    const current = event({ id: 'current', startsAt: new Date(now).toISOString() });
    const upcoming = event({ id: 'upcoming', startsAt: new Date(now + 60_000).toISOString() });
    const paused = event({ id: 'paused', status: 'paused' });
    const catalogue = [upcoming, current, paused, event({ id: 'ended', endsAt: new Date(now).toISOString() }),
      event({ id: 'closed', status: 'closed' }), event({ id: 'cancelled', status: 'cancelled' }), event({ id: 'draft', status: 'draft' })];
    expect(discoverEvents(catalogue, options).map(({ event }) => event.id)).toEqual(['paused', 'current', 'upcoming']);
    expect(discoverEvents(catalogue, { ...options, period: 'current' }).map(({ event }) => event.id)).toEqual(['paused', 'current']);
    expect(discoverEvents(catalogue, { ...options, period: 'upcoming' }).map(({ event }) => event.id)).toEqual(['upcoming']);
  });

  it('searches the entire supplied catalogue without mutating it or imposing an extra page limit', () => {
    const catalogue = Array.from({ length: 501 }, (_, i) => event({ id: `${i}`, name: i === 500 ? 'Dernier rassemblement' : `Rassemblement ${i}` }));
    const ids = catalogue.map(({ id }) => id);
    expect(discoverEvents(catalogue, { ...options, query: 'dernier' }).map(({ event }) => event.id)).toEqual(['500']);
    expect(discoverEvents(catalogue, options)).toHaveLength(501);
    expect(catalogue.map(({ id }) => id)).toEqual(ids);
  });

  it('filters and sorts by approximate distance locally; removing position restores distant results', () => {
    const nearby = event({ id: 'nearby' });
    const farther = event({ id: 'farther', geofence: { type: 'Polygon', coordinates: [[[2.45, 48.85], [2.46, 48.85], [2.46, 48.86], [2.45, 48.86], [2.45, 48.85]]] } });
    const catalogue = [farther, nearby];
    expect(discoverEvents(catalogue, { ...options, position: [2.355, 48.855], radiusKm: 5 }).map(({ event }) => event.id)).toEqual(['nearby']);
    expect(discoverEvents(catalogue, { ...options, position: [2.355, 48.855], radiusKm: 25 }).map(({ event }) => event.id)).toEqual(['nearby', 'farther']);
    expect(discoverEvents(catalogue, { ...options, position: null, radiusKm: 5 })).toHaveLength(2);
    expect(approximateDistance(800)).toBe('À moins de 1 km');
    expect(approximateDistance(7_600)).toBe('À environ 8 km');
  });
});

describe('optional discovery location', () => {
  it('accepts a coarse one-shot fix without sending or persisting it', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { longitude: 2.355, latitude: 48.855, accuracy: 5_000 }
    } as GeolocationPosition));
    const fetch = vi.fn();
    const setItem = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('localStorage', { setItem });
    vi.stubGlobal('indexedDB', { open });
    await expect(locateForDiscovery()).resolves.toEqual([2.355, 48.855]);
    expect(getCurrentPosition).toHaveBeenCalledExactlyOnceWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: false, maximumAge: 0, timeout: 10_000
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([[1, 'denied'], [2, 'unavailable'], [3, 'timeout']] as const)('maps native error %s to a usable fallback', async (code, expected) => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => failure({ code } as GeolocationPositionError) } });
    await expect(locateForDiscovery()).rejects.toMatchObject({ code: expected });
  });

  it('handles an unsupported browser and invalid coordinates without retaining a fallback location', async () => {
    vi.stubGlobal('navigator', {});
    await expect(locateForDiscovery()).rejects.toMatchObject({ code: 'unsupported' });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { longitude: NaN, latitude: 48.8 } } as GeolocationPosition) } });
    await expect(locateForDiscovery()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
