import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupportFlow, type SupportFlowState } from '../../src/lib/client/support';
import { getDailySupportIdentity, getEventIdentity } from '../../src/lib/client/identity';
import type { CounterSnapshot, PublicEvent } from '../../src/lib/shared/types';

vi.mock('../../src/lib/client/identity', async (original) => ({
  ...await original<typeof import('../../src/lib/client/identity')>(),
  getEventIdentity: vi.fn(), getDailySupportIdentity: vi.fn()
}));

const eventId = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const identity = 'A'.repeat(43);
const dayIdentity = 'B'.repeat(43);
const fetchMock = vi.fn();
const geolocate = vi.fn();
const flows: ReturnType<typeof createSupportFlow>[] = [];

function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: eventId, slug: 'test', name: 'Test', cityCode: '75056', cityName: 'Paris', description: null,
    geofence: { type: 'Polygon', coordinates: [[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.8]]] },
    geofenceVersion: 1, metadataVersion: 1, startsAt: '2026-10-16T12:00:00.000Z', endsAt: '2026-10-18T14:00:00.000Z',
    status: 'published', integrityStatus: 'normal', protocolVersion: 1, isTest: true,
    finalizedAt: null, presencesPurgedAt: null, ...overrides
  };
}

function snapshot(overrides: Partial<CounterSnapshot> = {}): CounterSnapshot {
  return {
    eventId, total: '8', revision: '8', supportTotal: '2', supportRevision: '2',
    day: '2026-10-16', nationalTotal: '8', nationalRevision: '8',
    nationalSupportTotal: '2', nationalSupportRevision: '2', cityTotal: '8', cityRevision: '8',
    citySupportTotal: '2', citySupportRevision: '2', epoch: '1', metadataVersion: 1,
    serverTime: '2026-10-16T13:00:00.000Z', eventStatus: 'published', integrityStatus: 'normal',
    startsAt: event().startsAt, endsAt: event().endsAt, ...overrides
  };
}

function reply(status: string, overrides: Partial<CounterSnapshot> = {}, httpStatus = 200): Response {
  return new Response(JSON.stringify({ status, snapshot: snapshot(overrides) }), {
    status: httpStatus, headers: { 'Content-Type': 'application/json' }
  });
}

function setup(events = [event()]) {
  const states: SupportFlowState[] = [];
  const snapshots: CounterSnapshot[] = [];
  const flow = createSupportFlow({
    getEvents: () => events, onChange: (state) => states.push(state),
    onSnapshot: (value) => snapshots.push(value)
  });
  flows.push(flow);
  return { flow, states, snapshots };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Deliberately a different day from the server: the device clock must not set the daily token.
  vi.setSystemTime(new Date('2026-10-17T13:00:00.000Z'));
  vi.stubGlobal('navigator', { onLine: true, geolocation: { getCurrentPosition: geolocate } });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  geolocate.mockReset();
  vi.mocked(getEventIdentity).mockReset().mockResolvedValue(identity);
  vi.mocked(getDailySupportIdentity).mockReset().mockResolvedValue(dayIdentity);
});

afterEach(() => {
  for (const flow of flows.splice(0)) flow.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('remote support flow', () => {
  it('uses the server day, sends no position, and waits for a support confirmation', async () => {
    let resolveSubmission!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(reply('not_supported'))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSubmission = resolve; }));
    const { flow, states, snapshots } = setup();
    const work = flow.support(eventId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(states.at(-1)?.phase).toBe('submitting');
    expect(snapshots).toEqual([snapshot()]);
    expect(getDailySupportIdentity).toHaveBeenCalledExactlyOnceWith('2026-10-16');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/events/${eventId}/support-status`, `/api/events/${eventId}/supports`
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ anonymousEventId: identity });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      anonymousEventId: identity, anonymousDayId: dayIdentity, day: '2026-10-16', protocolVersion: 1
    });
    expect(geolocate).not.toHaveBeenCalled();
    await flow.support(eventId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveSubmission(reply('supported', { supportTotal: '3', supportRevision: '3' }));
    await work;
    expect(states.at(-1)?.phase).toBe('supported');
    expect(snapshots.at(-1)?.supportTotal).toBe('3');
  });

  it.each(['supported', 'present'] as const)('recovers an existing %s without another admission', async (status) => {
    fetchMock.mockResolvedValue(reply(status));
    const { flow, states } = setup();
    await flow.support(eventId);
    expect(states.at(-1)?.phase).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDailySupportIdentity).not.toHaveBeenCalled();
    expect(geolocate).not.toHaveBeenCalled();
  });

  it('only checks status when recovering a support', async () => {
    fetchMock.mockResolvedValue(reply('not_supported'));
    const { flow, states } = setup();
    await flow.verify(eventId);
    expect(states.at(-1)?.phase).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDailySupportIdentity).not.toHaveBeenCalled();
  });

  it('retains the explicit city scope without sending its perimeter', async () => {
    fetchMock.mockResolvedValueOnce(reply('not_supported'))
      .mockResolvedValueOnce(reply('supported'));
    const { flow } = setup([event({ countingScope: 'city' })]);
    await flow.support(eventId);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      anonymousEventId: identity, anonymousDayId: dayIdentity,
      day: '2026-10-16', protocolVersion: 1, countingScope: 'city'
    });
    expect(geolocate).not.toHaveBeenCalled();
  });

  it('never retries a lost submission automatically and verifies before explicit retry', async () => {
    fetchMock.mockResolvedValueOnce(reply('not_supported'))
      .mockRejectedValueOnce(new TypeError('network'));
    const { flow, states, snapshots } = setup();
    await flow.support(eventId);
    expect(states.at(-1)).toMatchObject({ phase: 'pending', code: 'network_error' });
    expect(snapshots.at(-1)?.supportTotal).toBe('2');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    fetchMock.mockResolvedValueOnce(reply('supported', { supportTotal: '3', supportRevision: '3' }));
    await flow.retry();
    expect(fetchMock.mock.calls[2]![0]).toBe(`/api/events/${eventId}/support-status`);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(states.at(-1)?.phase).toBe('supported');
  });

  it('resubmits only after a status check confirms the previous request is missing', async () => {
    fetchMock.mockResolvedValueOnce(reply('not_supported'))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(reply('not_supported'))
      .mockResolvedValueOnce(reply('already_supported'));
    const { flow, states } = setup();
    await flow.support(eventId);
    await flow.retry();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/events/${eventId}/support-status`, `/api/events/${eventId}/supports`,
      `/api/events/${eventId}/support-status`, `/api/events/${eventId}/supports`
    ]);
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[3]![1].body);
    expect(states.at(-1)?.phase).toBe('supported');
  });

  it('refreshes the server day once after midnight and does not loop', async () => {
    fetchMock.mockResolvedValueOnce(reply('not_supported'))
      .mockResolvedValueOnce(reply('day_changed', {}, 409))
      .mockResolvedValueOnce(reply('not_supported', { day: '2026-10-17' }))
      .mockResolvedValueOnce(reply('day_changed', {}, 409));
    const { flow, states } = setup();
    await flow.support(eventId);
    expect(getDailySupportIdentity).toHaveBeenNthCalledWith(1, '2026-10-16');
    expect(getDailySupportIdentity).toHaveBeenNthCalledWith(2, '2026-10-17');
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body).day).toBe('2026-10-17');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'day_changed' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('explains the daily limit and never credits a rejected support', async () => {
    fetchMock.mockResolvedValueOnce(reply('not_supported'))
      .mockResolvedValueOnce(reply('daily_limit_reached', {}, 409));
    const { flow, states, snapshots } = setup();
    await flow.support(eventId);
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'daily_limit_reached' });
    expect(states.at(-1)?.message).toContain('heure de Paris');
    expect(snapshots.every((value) => value.supportTotal === '2')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recognizes presence recorded between status and submission', async () => {
    fetchMock.mockResolvedValueOnce(reply('not_supported'))
      .mockResolvedValueOnce(reply('already_present'));
    const { flow, states } = setup();
    await flow.support(eventId);
    expect(states.at(-1)?.phase).toBe('present');
    expect(states.at(-1)?.message).toContain('Aucun soutien supplémentaire');
  });

  it.each([
    ['details_expired', {}, 'details_expired'],
    ['not_supported', { eventStatus: 'closed' }, 'ended'],
    ['not_supported', { eventStatus: 'paused' }, 'paused'],
    ['not_supported', { startsAt: '2026-10-18T00:00:00.000Z' }, 'not_open']
  ] as const)('does not admit a support after a %s status with unavailable counting', async (status, overrides, code) => {
    fetchMock.mockResolvedValue(reply(status, overrides));
    const { flow, states } = setup();
    await flow.support(eventId);
    expect(states.at(-1)).toMatchObject({ phase: 'error', code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDailySupportIdentity).not.toHaveBeenCalled();
  });

  it('does not queue an offline support', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { flow, states } = setup();
    await flow.support(eventId);
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'offline' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getEventIdentity).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('updates the local confirmation when support becomes presence', async () => {
    fetchMock.mockResolvedValue(reply('supported'));
    const { flow, states } = setup();
    await flow.verify(eventId);
    flow.markPresent(eventId);
    expect(states.at(-1)?.phase).toBe('present');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
