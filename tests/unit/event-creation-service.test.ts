import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn(), preflight: vi.fn(), transaction: vi.fn(), invalidate: vi.fn(), boundary: vi.fn() }));
vi.mock('../../src/lib/server/db', () => ({
  transaction: mocked.transaction, getPool: () => ({ query: mocked.preflight }), realEventsApproved: () => false
}));
vi.mock('../../src/lib/server/public-data', () => ({ invalidatePublicCatalogue: mocked.invalidate }));
vi.mock('../../src/lib/server/events', () => ({ publicEvent: (row: unknown) => row }));
vi.mock('../../src/lib/server/maps', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/server/maps')>(), getPublicPlaceBoundary: mocked.boundary
}));
import { createPublicEvent } from '../../src/lib/server/event-creation';
import { MapUnavailable } from '../../src/lib/server/maps';

const input = {
  requestId: '5a52252e-28ae-49f6-ab20-98805d61d094', name: 'Rassemblement fictif', cityName: 'Paris', cityCode: '75056',
  publicCenter: [2.36, 48.86], radiusMeters: 500, durationMinutes: 240, publicLocationConfirmed: true
};
const cityInput = {
  requestId: input.requestId, name: 'Comptage de Paris', cityName: 'Paris', cityCode: '75056',
  countingScope: 'city', durationMinutes: 240, publicLocationConfirmed: true
};
const officialBoundary = {
  code: '75056', name: 'Paris', center: [2.36, 48.86],
  geofence: { type: 'MultiPolygon', coordinates: [
    [[[2.2, 48.8], [2.4, 48.8], [2.4, 48.9], [2.2, 48.9], [2.2, 48.8]]],
    [[[2.5, 48.8], [2.6, 48.8], [2.6, 48.9], [2.5, 48.9], [2.5, 48.8]]]
  ] }
};
function expectedHash(startsAt?: string) {
  const fields = [input.name, input.cityName, input.cityCode, input.publicCenter,
    input.radiusMeters, input.durationMinutes, input.publicLocationConfirmed];
  if (startsAt !== undefined) fields.push(startsAt);
  return createHash('sha256').update(JSON.stringify(fields)).digest();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.transaction.mockImplementation((operation) => operation({ query: mocked.query }));
  mocked.query.mockResolvedValue({ rows: [{ id: input.requestId, schedule_valid: true }] });
  mocked.preflight.mockResolvedValue({ rows: [] });
  mocked.boundary.mockResolvedValue(officialBoundary);
});

describe('whole-commune creation service without a database', () => {
  it('resolves the selected code on the server and persists every part of the official perimeter as a city count', async () => {
    expect((await createPublicEvent({ ...cityInput, cityName: 'Nom déclaré par le navigateur' })).status).toBe('created');
    expect(mocked.boundary).toHaveBeenCalledExactlyOnceWith('75056');
    expect(mocked.preflight).toHaveBeenCalledExactlyOnceWith(expect.any(String), [cityInput.requestId]);
    const [sql, parameters] = mocked.query.mock.calls[0]!;
    expect(sql).toContain('counting_scope');
    expect(parameters).toContain('city');
    expect(parameters).toContain(JSON.stringify(officialBoundary.geofence));
    expect(parameters[4]).toBe('Paris');
    expect(mocked.invalidate).toHaveBeenCalledOnce();
  });

  it('returns a recoverable provider error without inserting an event when the official contour cannot load', async () => {
    mocked.boundary.mockRejectedValueOnce(new MapUnavailable());
    expect(await createPublicEvent(cityInput)).toEqual({ status: 'temporarily_unavailable' });
    expect(mocked.transaction).not.toHaveBeenCalled();
    expect(mocked.query).not.toHaveBeenCalled();
    expect(mocked.invalidate).not.toHaveBeenCalled();
  });

  it('recognizes a committed replay without loading the provider again, even after its schedule has ended', async () => {
    const startsAt = '2000-01-01T00:00:00.000Z';
    await createPublicEvent({ ...cityInput, startsAt });
    const parameters = mocked.query.mock.calls[0]![1] as unknown[];
    const digest = parameters.find((value) => Buffer.isBuffer(value));
    expect(digest).toBeInstanceOf(Buffer);
    const stored = {
      id: cityInput.requestId, creation_source: 'community', creation_request_hash: digest,
      counting_scope: 'city', geofence: officialBoundary.geofence,
      starts_at: new Date(startsAt), ends_at: new Date('2000-01-01T04:00:00.000Z')
    };
    mocked.preflight.mockResolvedValueOnce({ rows: [stored] });
    mocked.boundary.mockRejectedValueOnce(new MapUnavailable());
    mocked.boundary.mockClear();
    mocked.query.mockClear();
    mocked.transaction.mockClear();
    expect(await createPublicEvent({ ...cityInput, startsAt })).toEqual({ status: 'already_created', event: stored });
    expect(mocked.boundary).not.toHaveBeenCalled();
    expect(mocked.transaction).not.toHaveBeenCalled();
    expect(mocked.query).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'Autre comptage' }, { cityCode: '59000', cityName: 'Lille' },
    { durationMinutes: 120 }, { startsAt: '2100-01-01T00:00:00Z' }
  ])('rejects a changed committed request before contacting the contour provider', async (replacement) => {
    await createPublicEvent(cityInput);
    const parameters = mocked.query.mock.calls[0]![1] as unknown[];
    const digest = parameters.find((value) => Buffer.isBuffer(value));
    mocked.preflight.mockResolvedValueOnce({ rows: [{
      id: cityInput.requestId, creation_source: 'community', creation_request_hash: digest, counting_scope: 'city'
    }] });
    mocked.boundary.mockClear();
    mocked.query.mockClear();
    expect(await createPublicEvent({ ...cityInput, ...replacement })).toEqual({ status: 'request_conflict' });
    expect(mocked.boundary).not.toHaveBeenCalled();
    expect(mocked.query).not.toHaveBeenCalled();
  });

  it('normalizes equivalent explicit starts before comparing city replay digests', async () => {
    await createPublicEvent({ ...cityInput, startsAt: '2030-07-15T15:30:00+02:00' });
    const first = mocked.query.mock.calls[0]![1] as unknown[];
    const firstDigest = first.find((value) => Buffer.isBuffer(value));
    expect(first).toContain('2030-07-15T13:30:00.000Z');
    await createPublicEvent({ ...cityInput, startsAt: '2030-07-15T13:30:00Z' });
    const second = mocked.query.mock.calls[1]![1] as unknown[];
    expect(second.find((value) => Buffer.isBuffer(value))).toEqual(firstDigest);
  });

  it('does not misclassify a preflight database outage as a cartography outage', async () => {
    const failure = new Error('synthetic preflight database failure');
    mocked.preflight.mockRejectedValueOnce(failure);
    await expect(createPublicEvent(cityInput)).rejects.toBe(failure);
    expect(mocked.boundary).not.toHaveBeenCalled();
  });

  it('recognizes a concurrent commit after the provider failed', async () => {
    await createPublicEvent(cityInput);
    const parameters = mocked.query.mock.calls[0]![1] as unknown[];
    const digest = parameters.find((value) => Buffer.isBuffer(value));
    const stored = {
      id: cityInput.requestId, creation_source: 'community', creation_request_hash: digest, counting_scope: 'city'
    };
    mocked.preflight.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [stored] });
    mocked.boundary.mockRejectedValueOnce(new MapUnavailable());
    mocked.query.mockClear();
    expect(await createPublicEvent(cityInput)).toEqual({ status: 'already_created', event: stored });
    expect(mocked.query).not.toHaveBeenCalled();
  });

  it.each([
    { creation_source: 'team', counting_scope: 'city' },
    { creation_source: 'community', counting_scope: 'gathering' }
  ])('does not treat a different stored creation source or scope as a city replay', async (storedFields) => {
    await createPublicEvent(cityInput);
    const parameters = mocked.query.mock.calls[0]![1] as unknown[];
    const digest = parameters.find((value) => Buffer.isBuffer(value));
    mocked.preflight.mockResolvedValueOnce({ rows: [{
      id: cityInput.requestId, creation_request_hash: digest, ...storedFields
    }] });
    mocked.boundary.mockClear();
    expect(await createPublicEvent(cityInput)).toEqual({ status: 'request_conflict' });
    expect(mocked.boundary).not.toHaveBeenCalled();
  });
});

describe('event scheduling service without a database', () => {
  it('preserves the legacy immediate-request digest and delegates the omitted start to PostgreSQL', async () => {
    expect((await createPublicEvent(input)).status).toBe('created');
    expect(mocked.query.mock.calls[0]![1][9]).toEqual(expectedHash());
    expect(mocked.query.mock.calls[0]![1][10]).toBeNull();
  });

  it('hashes the normalized explicit instant so equivalent offsets remain an exact replay', async () => {
    await createPublicEvent({ ...input, startsAt: '2030-07-15T15:30:00+02:00' });
    const firstHash = mocked.query.mock.calls[0]![1][9];
    expect(firstHash).toEqual(expectedHash('2030-07-15T13:30:00.000Z'));
    expect(mocked.query.mock.calls[0]![1][10]).toBe('2030-07-15T13:30:00.000Z');
    await createPublicEvent({ ...input, startsAt: '2030-07-15T13:30:00Z' });
    expect(mocked.query.mock.calls[1]![1][9]).toEqual(firstHash);
    expect(firstHash).not.toEqual(expectedHash());
  });

  it('aborts the transaction on an expired newly inserted schedule and does not invalidate the catalogue', async () => {
    let aborted = false;
    mocked.transaction.mockImplementationOnce(async (operation) => {
      try { return await operation({ query: mocked.query }); }
      catch (error) { aborted = true; throw error; }
    });
    mocked.query.mockResolvedValueOnce({ rows: [{ id: input.requestId, schedule_valid: false }] });
    expect(await createPublicEvent({ ...input, startsAt: '2000-01-01T00:00:00Z' })).toEqual({ status: 'invalid_schedule' });
    expect(aborted).toBe(true);
    expect(mocked.query).toHaveBeenCalledTimes(1);
    expect(mocked.invalidate).not.toHaveBeenCalled();
  });

  it('recognizes an existing expired request instead of validating its schedule again', async () => {
    const startsAt = '2000-01-01T00:00:00.000Z';
    mocked.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      id: input.requestId, creation_source: 'community', creation_request_hash: expectedHash(startsAt),
      starts_at: new Date(startsAt), ends_at: new Date('2000-01-01T04:00:00.000Z')
    }] });
    expect((await createPublicEvent({ ...input, startsAt })).status).toBe('already_created');
    expect(mocked.invalidate).toHaveBeenCalledOnce();
  });

  it('returns conflict for a changed expired start rather than invalid_schedule', async () => {
    mocked.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      id: input.requestId, creation_source: 'community', creation_request_hash: expectedHash('2000-01-01T00:00:00.000Z')
    }] });
    expect(await createPublicEvent({ ...input, startsAt: '2000-01-02T00:00:00Z' })).toEqual({ status: 'request_conflict' });
    expect(mocked.invalidate).not.toHaveBeenCalled();
  });

  it('preserves unexpected database failures instead of presenting them as invalid dates', async () => {
    const failure = new Error('synthetic database failure');
    mocked.query.mockRejectedValueOnce(failure);
    await expect(createPublicEvent(input)).rejects.toBe(failure);
  });
});
