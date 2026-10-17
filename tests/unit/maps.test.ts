import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiPolygon, Polygon } from 'geojson';

const boundary: Polygon = {
  type: 'Polygon', coordinates: [[[2.2, 48.8], [2.4, 48.8], [2.4, 48.9], [2.2, 48.9], [2.2, 48.8]]]
};
const island: Polygon = {
  type: 'Polygon', coordinates: [[[2.5, 48.8], [2.6, 48.8], [2.6, 48.9], [2.5, 48.9], [2.5, 48.8]]]
};
const officialPlace = (contour: Polygon | MultiPolygon = boundary) => ({
  nom: 'Paris', code: '75056', centre: { type: 'Point', coordinates: [2.347, 48.8589] }, contour
});

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('public cartography gateway', () => {
  it('accepts town names and rejects coordinates, URL injection and oversized queries', async () => {
    const { normalizePlaceQuery } = await import('../../src/lib/server/maps');
    expect(normalizePlaceQuery('  Saint-Étienne   du Rouvray  ')).toBe('Saint-Étienne du Rouvray');
    for (const value of ['2.365,48.865', 'https://other.invalid', '<svg>', 'A', 'A'.repeat(81), 'Paris\u0000']) {
      expect(normalizePlaceQuery(value)).toBeNull();
    }
  });
  it('bounds tile coordinates and disallows alternate numeric representations', async () => {
    const { parseTile } = await import('../../src/lib/server/maps');
    expect(parseTile('16', '33196', '22546')).toEqual([16, 33196, 22546]);
    for (const parts of [['20','0','0'], ['4','0','0'], ['5','32','0'], ['5','0','32'], ['5','-1','0'], ['05','1','1'], ['5','1e1','1']]) {
      expect(parseTile(parts[0]!, parts[1]!, parts[2]!)).toBeNull();
    }
  });
  it('queries only the fixed official endpoint and shares cached responses without visitor headers', async () => {
    const fetchMock = vi.fn(async () => Response.json([{ nom: 'Paris', code: '75056', centre: { coordinates: [2.347, 48.8589] } }]));
    vi.stubGlobal('fetch', fetchMock);
    const { searchPublicPlaces } = await import('../../src/lib/server/maps');
    const result = await Promise.all([searchPublicPlaces('Paris'), searchPublicPlaces('Paris')]);
    expect(result[0]).toEqual([{ code: '75056', name: 'Paris', center: [2.347, 48.8589] }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[0].origin).toBe('https://geo.api.gouv.fr');
    expect([...call[0].searchParams.keys()].sort()).toEqual(['boost','fields','limit','nom']);
    expect(call[1].headers).toEqual({ accept: 'application/json' });
    expect(call[1].redirect).toBe('error');
    await searchPublicPlaces('PARIS');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized upstream replies rather than storing them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { headers: { 'content-length': '24001' } })));
    const { searchPublicPlaces } = await import('../../src/lib/server/maps');
    await expect(searchPublicPlaces('Paris')).rejects.toBeInstanceOf(Error);
  });
  it('loads a validated whole-commune contour from the fixed official endpoint and shares its cache', async () => {
    const fetchMock = vi.fn(async () => Response.json(officialPlace()));
    vi.stubGlobal('fetch', fetchMock);
    const { getPublicPlaceBoundary } = await import('../../src/lib/server/maps');
    const results = await Promise.all([getPublicPlaceBoundary('75056'), getPublicPlaceBoundary('75056')]);
    expect(results[0]).toEqual({ code: '75056', name: 'Paris', center: [2.347, 48.8589], geofence: boundary });
    expect(results[1]).toEqual(results[0]);
    expect(await getPublicPlaceBoundary('75056')).toEqual(results[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[0].origin).toBe('https://geo.api.gouv.fr');
    expect(call[0].pathname).toBe('/communes/75056');
    expect([...call[0].searchParams.keys()]).toEqual(['fields']);
    expect(call[0].searchParams.get('fields')?.split(',').sort()).toEqual(['centre', 'code', 'contour', 'nom']);
    expect(call[1].headers).toEqual({ accept: 'application/json' });
    expect(call[1].redirect).toBe('error');
  });
  it('retains each island of an official MultiPolygon without replacing it with a circle or bounding box', async () => {
    const geofence: MultiPolygon = { type: 'MultiPolygon', coordinates: [boundary.coordinates, island.coordinates] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(officialPlace(geofence))));
    const { getPublicPlaceBoundary } = await import('../../src/lib/server/maps');
    expect((await getPublicPlaceBoundary('75056')).geofence).toEqual(geofence);
  });
  it.each(['', 'Paris', '75056/../59000', '75056?fields=private', 'https://other.invalid', '750560'])
    ('rejects an invalid commune code %s without contacting a provider', async (code) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { getPublicPlaceBoundary } = await import('../../src/lib/server/maps');
      await expect(getPublicPlaceBoundary(code)).rejects.toBeInstanceOf(Error);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  it.each([
    { code: '59000' }, { nom: '<script>' }, { nom: 'x'.repeat(121) },
    { centre: { type: 'Point', coordinates: [2, null] } },
    { centre: { type: 'Point', coordinates: [181, 48] } },
    { contour: undefined }, { contour: { type: 'MultiPolygon', coordinates: [] } },
    { contour: { type: 'Polygon', coordinates: [[[2, 48], [3, 48], [3, 49]]] } },
    { contour: { type: 'Polygon', coordinates: [[[2, 48], [3, 49], [2, 49], [3, 48], [2, 48]]] } }
  ])('rejects an untrusted or malformed official-boundary response and allows a later retry', async (replacement) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...officialPlace(), ...replacement }))
      .mockImplementation(async () => Response.json(officialPlace()));
    vi.stubGlobal('fetch', fetchMock);
    const { getPublicPlaceBoundary } = await import('../../src/lib/server/maps');
    await expect(getPublicPlaceBoundary('75056')).rejects.toBeInstanceOf(Error);
    expect((await getPublicPlaceBoundary('75056')).geofence).toEqual(boundary);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    () => new Response('{}', { headers: { 'content-length': '2000000' } }),
    () => new Response(' '.repeat(2_000_000)),
    () => new Response('{}', { status: 503 }),
    () => new Response('<html>provider failure</html>')
  ])('bounds and validates boundary responses before caching them', async (response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const { getPublicPlaceBoundary } = await import('../../src/lib/server/maps');
    await expect(getPublicPlaceBoundary('75056')).rejects.toBeInstanceOf(Error);
  });
  it('serves validated PNG tiles from a bounded shared cache', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const fetchMock = vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { getPublicTile } = await import('../../src/lib/server/maps');
    expect(await getPublicTile([16,33196,22546])).toEqual(png);
    expect(await getPublicTile([16,33196,22546])).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[0].origin).toBe('https://data.geopf.fr');
    expect(call[0].searchParams.get('LAYER')).toBe('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2');
    expect(call[1].headers).toEqual({ accept: 'image/png' });
  });
  it('rejects an upstream XML error masquerading as an image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<error/>', { headers: { 'content-type': 'image/png' } })));
    const { getPublicTile } = await import('../../src/lib/server/maps');
    await expect(getPublicTile([16,33196,22546])).rejects.toBeInstanceOf(Error);
  });
  it('bounds concurrent upstream requests even across distinct towns', async () => {
    const resolvers: (() => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => resolvers.push(() => resolve(Response.json([]))))));
    const { searchPublicPlaces } = await import('../../src/lib/server/maps');
    const pending = Array.from({ length: 16 }, (_, index) => searchPublicPlaces(`Ville ${index}`));
    await expect(searchPublicPlaces('Autre ville')).rejects.toBeInstanceOf(Error);
    resolvers.forEach((resolve) => resolve());
    await Promise.all(pending);
  });
});
