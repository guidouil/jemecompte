import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createParticipationFlow } from '../../src/lib/client/participation';
import { getEventIdentity } from '../../src/lib/client/identity';
import { locateEvents, LocationError } from '../../src/lib/client/geolocation';
import type { CounterSnapshot, FlowState, PublicEvent } from '../../src/lib/shared/types';

vi.mock('../../src/lib/client/admission', async (original) => ({
  ...await original<typeof import('../../src/lib/client/admission')>(),
  getAdmissionProof: vi.fn().mockResolvedValue({ token: 'synthetic-work-token', nonce: 7 })
}));

vi.mock('../../src/lib/client/identity', async (original) => ({
  ...await original<typeof import('../../src/lib/client/identity')>(),
  getEventIdentity: vi.fn()
}));
vi.mock('../../src/lib/client/geolocation', async (original) => ({
  ...await original<typeof import('../../src/lib/client/geolocation')>(),
  locateEvents: vi.fn()
}));

const eventId = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const identity = 'A'.repeat(43);
const flows: ReturnType<typeof createParticipationFlow>[] = [];
const fetchMock = vi.fn();

function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: eventId, slug: 'test', name: 'Test', cityCode: '75056', cityName: 'Paris', description: null,
    geofence: { type: 'Polygon', coordinates: [[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.8]]] },
    geofenceVersion: 1, metadataVersion: 1,
    startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 600_000).toISOString(),
    status: 'published', integrityStatus: 'normal', protocolVersion: 1, isTest: true,
    finalizedAt: null, presencesPurgedAt: null, ...overrides
  };
}

function snapshot(overrides: Partial<CounterSnapshot> = {}): CounterSnapshot {
  return {
    eventId, total: '1', revision: '1', day: '2026-10-16', nationalTotal: '1', nationalRevision: '1',
    cityTotal: '1', cityRevision: '1', epoch: '1', metadataVersion: 1, serverTime: new Date().toISOString(),
    eventStatus: 'published', integrityStatus: 'normal', startsAt: event().startsAt, endsAt: event().endsAt,
    ...overrides
  };
}

function reply(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function setup(events = [event()]) {
  const states: FlowState[] = [];
  const snapshots: CounterSnapshot[] = [];
  const onEvent = vi.fn();
  const flow = createParticipationFlow({
    getEvents: () => events, onChange: (state) => states.push(state),
    onSnapshot: (value) => snapshots.push(value), onEvent
  });
  flows.push(flow);
  return { flow, states, snapshots, onEvent };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T13:00:00.000Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', new EventTarget());
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', document);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.mocked(getEventIdentity).mockReset().mockResolvedValue(identity);
  vi.mocked(locateEvents).mockReset().mockImplementation(async (events, selected) => ({
    events: events.filter((candidate) => !selected || candidate.id === selected), capturedAt: Date.now()
  }));
});

afterEach(() => {
  for (const flow of flows.splice(0)) flow.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('participation flow', () => {
  it('sends only the strict declaration and waits for server confirmation', async () => {
    let resolveResponse!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const { flow, states, snapshots } = setup();
    const work = flow.count(eventId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(states.at(-1)?.phase).toBe('submitting');
    expect(snapshots).toEqual([]);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/events/${eventId}/presences`);
    expect(JSON.parse(init.body)).toEqual({
      anonymousEventId: identity, geofenceVersion: 1, protocolVersion: 1, insideZone: true,
      admission: { token: 'synthetic-work-token', nonce: 7 }
    });
    expect(init.cache).toBe('no-store');
    resolveResponse(reply({ status: 'counted', snapshot: snapshot() }));
    await work;
    expect(states.at(-1)?.phase).toBe('counted');
    expect(snapshots).toHaveLength(1);
  });

  it('makes no request or identity after denied geolocation', async () => {
    vi.mocked(locateEvents).mockRejectedValue(new LocationError('permission_denied', 'Localisation refusée.'));
    const { flow, states } = setup();
    await flow.count();
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'permission_denied' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getEventIdentity).not.toHaveBeenCalled();
  });

  it('lets the user choose overlapping events without a second fresh fix', async () => {
    const other = event({ id: '3e3f5fe8-fb22-4e7b-8c24-ef448fb57ee8', name: 'Autre' });
    fetchMock.mockResolvedValue(reply({ status: 'counted', snapshot: snapshot({ eventId: other.id }) }));
    const { flow, states } = setup([event(), other]);
    await flow.count();
    expect(states.at(-1)?.phase).toBe('choosing');
    expect(fetchMock).not.toHaveBeenCalled();
    await flow.select(other.id);
    expect(locateEvents).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/events/${other.id}/presences`);
    expect(states.at(-1)?.phase).toBe('counted');
  });

  it('requires explicit confirmation for a single whole-city match before identity creation or submission', async () => {
    const city = event({ countingScope: 'city' });
    fetchMock.mockResolvedValue(reply({ status: 'counted', snapshot: snapshot({ countingScope: 'city' }) }));
    const { flow, states } = setup([city]);
    await flow.count();
    expect(states.at(-1)).toMatchObject({ phase: 'choosing', choices: [city] });
    expect(getEventIdentity).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await flow.select(city.id);
    expect(locateEvents).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      anonymousEventId: identity, geofenceVersion: 1, protocolVersion: 1, insideZone: true, countingScope: 'city',
      admission: { token: 'synthetic-work-token', nonce: 7 }
    });
    expect(states.at(-1)?.phase).toBe('counted');
  });

  it('uses the explicit city page choice directly while preserving the one-click gathering default', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'counted', snapshot: snapshot({ countingScope: 'city' }) }));
    const city = setup([event({ countingScope: 'city' })]);
    await city.flow.count(eventId);
    expect(city.states.some((state) => state.phase === 'choosing')).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).countingScope).toBe('city');
    fetchMock.mockClear().mockResolvedValue(reply({ status: 'counted', snapshot: snapshot() }));
    const gathering = setup();
    await gathering.flow.count();
    expect(gathering.states.some((state) => state.phase === 'choosing')).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty('countingScope');
  });

  it('keeps a mixed city and gathering choice separate and submits only the chosen scope', async () => {
    const city = event({ id: '3e3f5fe8-fb22-4e7b-8c24-ef448fb57ee8', countingScope: 'city' });
    fetchMock.mockResolvedValue(reply({ status: 'counted', snapshot: snapshot() }));
    const { flow, states } = setup([city, event()]);
    await flow.count();
    expect(states.at(-1)?.choices).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    await flow.select(eventId);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/events/${eventId}/presences`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty('countingScope');
  });

  it('retakes an expired city fix only after the explicit choice and never adds a second confirmation loop', async () => {
    const city = event({ countingScope: 'city' });
    fetchMock.mockResolvedValue(reply({ status: 'counted', snapshot: snapshot({ countingScope: 'city' }) }));
    const { flow, states } = setup([city]);
    await flow.count();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await flow.select(city.id);
    expect(locateEvents).toHaveBeenCalledTimes(2);
    expect(locateEvents).toHaveBeenLastCalledWith([city], city.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.phase).toBe('counted');
  });

  it('stops automatic retries when the server requires an explicit scope confirmation', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'scope_confirmation_required' }, 409));
    const { flow, states } = setup([event({ countingScope: 'city' })]);
    await flow.count(eventId);
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'scope_confirmation_required' });
    expect(states.at(-1)?.message).toContain('Rechargez la page');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a lost response with exactly the same event identity and no optimistic credit', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(reply({ status: 'already_counted', snapshot: snapshot() }));
    const { flow, states } = setup();
    await flow.count(eventId);
    expect(states.at(-1)?.phase).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1].body).toBe(fetchMock.mock.calls[1]?.[1].body);
    expect(locateEvents).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.phase).toBe('already_counted');
  });

  it('checks status first after freshness expires, then takes a new fix only on explicit retry', async () => {
    Object.assign(document, { visibilityState: 'hidden' });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    const { flow, states } = setup();
    await flow.count(eventId);
    await vi.advanceTimersByTimeAsync(61_000);
    Object.assign(document, { visibilityState: 'visible' });
    fetchMock.mockResolvedValueOnce(reply({ status: 'not_counted', snapshot: snapshot() }))
      .mockResolvedValueOnce(reply({ status: 'counted', snapshot: snapshot() }));
    await flow.retry();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/events/${eventId}/presences`, `/api/events/${eventId}/presence-status`, `/api/events/${eventId}/presences`
    ]);
    expect(locateEvents).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.phase).toBe('counted');
  });

  it('recovers a confirmed presence after closure without new location or admission', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'counted', snapshot: snapshot({ eventStatus: 'closed' }) }));
    const { flow, states } = setup([event({ status: 'closed' })]);
    await flow.count(eventId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/events/${eventId}/presence-status`);
    expect(locateEvents).not.toHaveBeenCalled();
    expect(states.at(-1)?.phase).toBe('already_counted');
  });

  it('does not create after a late status confirms that an unrecorded event is closed', async () => {
    Object.assign(document, { visibilityState: 'hidden' });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    const { flow, states } = setup();
    await flow.count(eventId);
    await vi.advanceTimersByTimeAsync(61_000);
    Object.assign(document, { visibilityState: 'visible' });
    fetchMock.mockResolvedValueOnce(reply({
      status: 'not_counted', snapshot: snapshot({ eventStatus: 'closed' })
    }));
    await flow.retry();
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'ended' });
    expect(locateEvents).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires a user action rather than silently locating on a late foreground resume', async () => {
    Object.assign(document, { visibilityState: 'hidden' });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    const { flow, states } = setup();
    await flow.count(eventId);
    await vi.advanceTimersByTimeAsync(61_000);
    fetchMock.mockResolvedValueOnce(reply({ status: 'not_counted', snapshot: snapshot() }));
    Object.assign(document, { visibilityState: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(states.at(-1)?.code).toBe('position_expired'));
    expect(locateEvents).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.phase).toBe('pending');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves geolocation denial when an explicit stale retry needs a new fix', async () => {
    Object.assign(document, { visibilityState: 'hidden' });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    const { flow, states } = setup();
    await flow.count(eventId);
    await vi.advanceTimersByTimeAsync(61_000);
    Object.assign(document, { visibilityState: 'visible' });
    fetchMock.mockResolvedValueOnce(reply({ status: 'not_counted', snapshot: snapshot() }));
    vi.mocked(locateEvents).mockRejectedValueOnce(new LocationError('permission_denied', 'Localisation refusée.'));
    await flow.retry();
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'permission_denied' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a status snapshot for another event instead of publishing its counters', async () => {
    fetchMock.mockResolvedValueOnce(reply({
      status: 'counted', snapshot: snapshot({ eventId: '3e3f5fe8-fb22-4e7b-8c24-ef448fb57ee8' })
    }));
    const { flow, states, snapshots } = setup();
    await flow.verify(eventId);
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'temporarily_unavailable' });
    expect(snapshots).toEqual([]);
  });

  it('never creates through verify and does not equate purged details with never counted', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'not_counted', snapshot: snapshot() }))
      .mockResolvedValueOnce(reply({ status: 'details_expired', snapshot: snapshot() }));
    const { flow, states } = setup();
    await flow.verify(eventId);
    expect(states.at(-1)?.phase).toBe('idle');
    await flow.verify(eventId);
    expect(states.at(-1)).toMatchObject({ phase: 'error', code: 'details_expired' });
    expect(locateEvents).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every((call) => call[0].endsWith('/presence-status'))).toBe(true);
  });

  it('honors Retry-After and bounds automatic retry requests', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply({ status: 'rate_limited' }, 429, { 'Retry-After': '30' })));
    const { flow, states } = setup();
    await flow.count(eventId);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    expect(states.at(-1)?.phase).toBe('pending');
  });
});
