import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ boundary: vi.fn() }));
vi.mock('../../src/lib/server/maps', () => ({ getPublicPlaceBoundary: mocked.boundary }));
import { GET } from '../../src/routes/api/places/[code]/boundary/+server';

const boundary = {
  code: '75056', name: 'Paris', center: [2.35, 48.85],
  geofence: { type: 'Polygon', coordinates: [[[2.2, 48.8], [2.4, 48.8], [2.4, 48.9], [2.2, 48.8]]] }
};

function request(code = '75056', search = ''): Parameters<typeof GET>[0] {
  return {
    params: { code }, url: new URL(`http://localhost/api/places/${code}/boundary${search}`)
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.boundary.mockResolvedValue(boundary);
});

describe('public whole-commune preview endpoint', () => {
  it('returns the server-validated official boundary with a public cache policy', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(await response.json()).toEqual(boundary);
    expect(mocked.boundary).toHaveBeenCalledExactlyOnceWith('75056');
  });

  it.each([
    ['Paris', ''], ['75056/../59000', ''], ['75056', '?url=https://other.invalid'],
    ['75056', '?lat=48.8&lon=2.3'], ['75056', '?code=59000']
  ])('rejects invalid codes and unrecognized query fields before calling the provider', async (code, search) => {
    const response = await GET(request(code, search));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'invalid_request' });
    expect(mocked.boundary).not.toHaveBeenCalled();
  });

  it('lets a transient provider failure be retried without exposing its error', async () => {
    mocked.boundary.mockRejectedValueOnce(new Error('private-provider-diagnostic'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toEqual({ status: 'temporarily_unavailable' });
  });
});
