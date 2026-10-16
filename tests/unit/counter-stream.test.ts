import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeCounters } from '../../src/lib/client/counter-stream';
import { mergeCounterSnapshots, parseCounterSnapshot } from '../../src/lib/client/counter-snapshot';
import type { CounterSnapshot } from '../../src/lib/shared/types';

const eventId = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const cleanups: (() => void)[] = [];

function snapshot(overrides: Partial<CounterSnapshot> = {}): CounterSnapshot {
  return {
    eventId, total: '5', revision: '5', day: '2026-10-16', nationalTotal: '5', nationalRevision: '5',
    cityTotal: '5', cityRevision: '5', epoch: '1', serverTime: '2026-10-16T13:00:00.000Z',
    metadataVersion: 1, eventStatus: 'published', integrityStatus: 'normal',
    startsAt: '2026-10-16T12:00:00.000Z', endsAt: '2026-10-16T18:00:00.000Z', ...overrides
  };
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | undefined;
  onerror: (() => void) | undefined;
  closed = false;
  constructor(public url: string) { super(); FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  counters(value: unknown) { this.dispatchEvent(new MessageEvent('counters', { data: JSON.stringify(value) })); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.instances = [];
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('counter snapshots', () => {
  it('accepts aggregate decreases after deleting an event without replaying an older larger total', () => {
    const before = snapshot({ nationalTotal: '20', nationalRevision: '20', cityTotal: '15', cityRevision: '15' });
    const after = mergeCounterSnapshots(before, snapshot({ serverTime: '2026-10-16T13:00:03.000Z', nationalTotal: '5', nationalRevision: '5', cityTotal: '5', cityRevision: '5' }));
    expect(after.nationalTotal).toBe('5');
    expect(after.cityTotal).toBe('5');
    expect(after.revision).toBe(before.revision);
    const delayed = mergeCounterSnapshots(after, before);
    expect(delayed.nationalTotal).toBe('5');
    expect(delayed.cityTotal).toBe('5');
    const tied = mergeCounterSnapshots(after, { ...before, serverTime: after.serverTime });
    expect(tied.nationalTotal).toBe('5');
  });

  it('compares BigInt revisions and accepts independent metadata and justified decreases', () => {
    const current = snapshot({ total: '90071992547409930', revision: '90071992547409930' });
    const metadata = mergeCounterSnapshots(current, snapshot({ metadataVersion: 2, eventStatus: 'paused' }));
    expect(metadata.total).toBe(current.total);
    expect(metadata.eventStatus).toBe('paused');
    const correction = mergeCounterSnapshots(metadata, snapshot({
      total: '4', revision: '90071992547409931', metadataVersion: 1
    }));
    expect(correction.total).toBe('4');
    expect(correction.eventStatus).toBe('paused');
  });

  it('rejects an older epoch and resets counters on a newer epoch or national day', () => {
    const current = snapshot({ epoch: '9' });
    expect(mergeCounterSnapshots(current, snapshot({ epoch: '8', revision: '1000' }))).toBe(current);
    expect(mergeCounterSnapshots(current, snapshot({ epoch: '10', total: '1', revision: '1' })).total).toBe('1');
    const tomorrow = mergeCounterSnapshots(current, snapshot({
      epoch: '9', day: '2026-10-17', nationalTotal: '0', nationalRevision: '0'
    }));
    expect(tomorrow.nationalTotal).toBe('0');
    expect(tomorrow.total).toBe('5');
    expect(parseCounterSnapshot({ ...current, revision: 'not-a-number' })).toBeUndefined();
  });
});

describe('counter subscriptions', () => {
  it('keeps one visible stream, validates messages and cleans up on hide and disposal', () => {
    const onSnapshot = vi.fn();
    const onConnectionChange = vi.fn();
    const cleanup = subscribeCounters(eventId, { onSnapshot, onConnectionChange });
    cleanups.push(cleanup);
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.counters(snapshot());
    first.counters(snapshot({ revision: '2', total: '2' }));
    first.counters(snapshot({ eventId: 'different' }));
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls.at(-1)?.[0].total).toBe('5');
    Object.assign(document, { visibilityState: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(first.closed).toBe(true);
    Object.assign(document, { visibilityState: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeEventSource.instances).toHaveLength(2);
    cleanup();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to bounded polling after repeated SSE failures without overlapping requests', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(snapshot()))));
    vi.stubGlobal('fetch', fetchMock);
    const onSnapshot = vi.fn();
    cleanups.push(subscribeCounters(eventId, { onSnapshot, onConnectionChange: vi.fn() }));
    FakeEventSource.instances[0]!.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.instances[1]!.onerror?.();
    await vi.advanceTimersByTimeAsync(2_000);
    FakeEventSource.instances[2]!.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/events/${eventId}/counters`);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
