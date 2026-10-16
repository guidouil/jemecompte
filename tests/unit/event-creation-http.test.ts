import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ create: vi.fn(), allow: vi.fn() }));
vi.mock('../../src/lib/server/event-creation', () => ({ createPublicEvent: mocked.create }));
vi.mock('../../src/lib/server/event-creation-abuse', () => ({ creationLimiter: { allow: mocked.allow } }));
import { POST } from '../../src/routes/api/events/create/+server';

const body = {
  requestId: '5a52252e-28ae-49f6-ab20-98805d61d094', name: 'Événement fictif', cityName: 'Paris', cityCode: '75056',
  publicCenter: [2.36,48.86], radiusMeters: 200, durationMinutes: 120, publicLocationConfirmed: true
};
function request(payload: unknown, origin = 'http://localhost'): Parameters<typeof POST>[0] {
  const req = new Request('http://localhost/api/events/create', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  return { request: req, url: new URL(req.url), getClientAddress: () => 'private-network-sentinel' } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.stubEnv('ORIGIN', 'http://localhost');
  vi.clearAllMocks();
  mocked.allow.mockReturnValue({ allowed: true, retryAfter: 3600 });
  mocked.create.mockResolvedValue({ status: 'created', event: { id: body.requestId, slug: 'fictif', isTest: true } });
});
afterEach(() => vi.unstubAllEnvs());

describe('public creation endpoint', () => {
  it('returns a created event without passing the network signal to the service', async () => {
    const response = await POST(request(body));
    expect(response.status).toBe(201);
    expect(mocked.create).toHaveBeenCalledExactlyOnceWith(body);
    expect(await response.json()).toMatchObject({ status: 'created', event: { id: body.requestId, isTest: true } });
  });
  it('does not create an event without confirmation, with an extra private field or from another origin', async () => {
    expect((await POST(request({ ...body, publicLocationConfirmed: false }))).status).toBe(400);
    expect((await POST(request({ ...body, anonymousEventId: 'participant-sentinel' }))).status).toBe(400);
    expect((await POST(request(body, 'https://other.example'))).status).toBe(403);
    expect(mocked.create).not.toHaveBeenCalled();
  });
  it('returns a bounded retry delay without exposing the raw network signal', async () => {
    mocked.allow.mockReturnValue({ allowed: false, retryAfter: 123 });
    const response = await POST(request(body));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('123');
    expect(await response.text()).not.toContain('private-network-sentinel');
    expect(mocked.create).not.toHaveBeenCalled();
  });
  it('distinguishes an idempotent replay from a conflicting public request', async () => {
    mocked.create.mockResolvedValueOnce({ status: 'already_created', event: { id: body.requestId, slug: 'fictif' } });
    expect((await POST(request(body))).status).toBe(200);
    mocked.create.mockResolvedValueOnce({ status: 'request_conflict' });
    expect((await POST(request(body))).status).toBe(409);
  });
  it('normalizes an explicit zoned start before calling the service', async () => {
    const response = await POST(request({ ...body, startsAt: '2030-07-15T15:30:00+02:00' }));
    expect(response.status).toBe(201);
    expect(mocked.create).toHaveBeenCalledExactlyOnceWith({ ...body, startsAt: '2030-07-15T13:30:00.000Z' });
  });
  it('returns a domain error when a new schedule has already ended', async () => {
    mocked.create.mockResolvedValueOnce({ status: 'invalid_schedule' });
    const response = await POST(request({ ...body, startsAt: '2000-01-01T00:00:00Z' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: 'invalid_schedule' });
  });
  it('rejects an unzoned start before applying creation limits or calling the service', async () => {
    expect((await POST(request({ ...body, startsAt: '2030-07-15T15:30:00' }))).status).toBe(400);
    expect(mocked.allow).not.toHaveBeenCalled();
    expect(mocked.create).not.toHaveBeenCalled();
  });
});
