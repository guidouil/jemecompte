import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../src/lib/server/db', () => ({ transaction: mocked.transaction, realEventsApproved: () => false }));
vi.mock('../../src/lib/server/public-data', () => ({ invalidatePublicCatalogue: mocked.invalidate }));
vi.mock('../../src/lib/server/events', () => ({ publicEvent: (row: unknown) => row }));
import { createPublicEvent } from '../../src/lib/server/event-creation';

const input = {
  requestId: '5a52252e-28ae-49f6-ab20-98805d61d094', name: 'Rassemblement fictif', cityName: 'Paris', cityCode: '75056',
  publicCenter: [2.36, 48.86], radiusMeters: 500, durationMinutes: 240, publicLocationConfirmed: true
};
function expectedHash(startsAt?: string) {
  const fields = [input.name, input.cityName, input.cityCode, input.publicCenter,
    input.radiusMeters, input.durationMinutes, input.publicLocationConfirmed];
  if (startsAt !== undefined) fields.push(startsAt);
  return createHash('sha256').update(JSON.stringify(fields)).digest();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.transaction.mockImplementation((operation) => operation({ query: mocked.query }));
  mocked.query.mockResolvedValue({ rows: [{ id: input.requestId, schedule_valid: true }] });
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
