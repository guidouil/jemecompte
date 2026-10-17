import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CounterSnapshot } from '../../src/lib/shared/types';

const getCounterSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/server/counters', () => ({ getCounterSnapshot }));

const eventId = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
let realtime: typeof import('../../src/lib/server/realtime');
const abortControllers: AbortController[] = [];

function snapshot(overrides: Partial<CounterSnapshot> = {}): CounterSnapshot {
  return {
    eventId, total: '5', revision: '5', day: '2026-10-16', nationalTotal: '8', nationalRevision: '8',
    cityTotal: '5', cityRevision: '5', epoch: '1', serverTime: '2026-10-16T13:00:00.000Z',
    eventStatus: 'published', integrityStatus: 'normal', metadataVersion: 1,
    startsAt: '2026-10-16T12:00:00.000Z', endsAt: '2026-10-16T18:00:00.000Z', ...overrides
  };
}

function signal(): AbortSignal {
  const controller = new AbortController();
  abortControllers.push(controller);
  return controller.signal;
}

function readerFor(response: Response | null): ReadableStreamDefaultReader<Uint8Array> {
  expect(response).not.toBeNull();
  expect(response?.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(response?.headers.get('cache-control')).toBe('no-store, no-transform');
  expect(response?.headers.get('x-accel-buffering')).toBe('no');
  if (!response?.body) throw new Error('Expected a readable counter stream.');
  return response.body.getReader();
}

async function readSnapshot(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<CounterSnapshot> {
  const result = await reader.read();
  expect(result.done).toBe(false);
  const frame = new TextDecoder().decode(result.value);
  expect(frame).toContain('event: counters\n');
  expect(frame.endsWith('\n\n')).toBe(true);
  const data = frame.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error('Expected an absolute counter snapshot.');
  return JSON.parse(data.slice('data: '.length)) as CounterSnapshot;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T13:00:00.000Z'));
  vi.stubEnv('REAL_EVENTS_APPROVED', 'false');
  vi.resetModules();
  getCounterSnapshot.mockReset();
  realtime = await import('../../src/lib/server/realtime');
});

afterEach(() => {
  for (const controller of abortControllers.splice(0)) controller.abort();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('shared realtime counter scheduler', () => {
  it('bounds subscriptions per network before initial database reads and releases every reservation', async () => {
    let finish!: (value: CounterSnapshot) => void;
    getCounterSnapshot.mockImplementationOnce(() => new Promise<CounterSnapshot>((resolve) => { finish = resolve; }));
    const pending = Array.from({ length: 64 }, () => realtime.counterStream(eventId, signal(), 'PRIVATE_NETWORK_SENTINEL'));
    await expect(realtime.counterStream(eventId, signal(), 'PRIVATE_NETWORK_SENTINEL')).rejects.toMatchObject({ peerLimited: true });
    const otherNetwork = realtime.counterStream(eventId, signal(), 'another-peer');
    finish(snapshot());
    const readers = (await Promise.all([...pending, otherNetwork])).map(readerFor);
    await Promise.all(readers.map(readSnapshot));
    expect(realtime.realtimeMetrics().connections).toBe(65);
    for (const reader of readers) await reader.cancel();
    expect(realtime.realtimeMetrics().connections).toBe(0);
    const fresh = readerFor(await realtime.counterStream(eventId, signal(), 'PRIVATE_NETWORK_SENTINEL'));
    await fresh.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends streams after five minutes using the shared scheduler and permits reconnection', async () => {
    getCounterSnapshot.mockResolvedValue(snapshot());
    const reader = readerFor(await realtime.counterStream(eventId, signal(), 'expiry-peer'));
    await readSnapshot(reader);
    for (let tick = 0; tick < 99; tick++) {
      await vi.advanceTimersByTimeAsync(3_000);
      await readSnapshot(reader);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(realtime.realtimeMetrics().connections).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const reconnected = readerFor(await realtime.counterStream(eventId, signal(), 'expiry-peer'));
    await reconnected.cancel();
  });

  it('releases network reservations after missing events and failed initial reads', async () => {
    getCounterSnapshot.mockResolvedValue(null);
    for (let i = 0; i < 70; i++) expect(await realtime.counterStream(eventId, signal(), 'failure-peer')).toBeNull();
    getCounterSnapshot.mockRejectedValue(new Error('private failure'));
    for (let i = 0; i < 70; i++) await expect(realtime.counterStream(eventId, signal(), 'failure-peer')).rejects.toThrow('private failure');
    getCounterSnapshot.mockResolvedValue(snapshot());
    const reader = readerFor(await realtime.counterStream(eventId, signal(), 'failure-peer'));
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes deleted-event streams and does not resurrect a pending pre-deletion read', async () => {
    getCounterSnapshot.mockResolvedValueOnce(snapshot());
    const reader = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    await readSnapshot(reader);
    realtime.closeEventStreams(eventId);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(realtime.realtimeMetrics()).toEqual({ connections: 0, channels: 0 });
    let finish!: (value: CounterSnapshot) => void;
    getCounterSnapshot.mockImplementationOnce(() => new Promise<CounterSnapshot>((resolve) => { finish = resolve; }));
    const pending = realtime.counterStream(eventId, signal(), 'realtime-test-peer');
    realtime.closeEventStreams(eventId);
    finish(snapshot());
    expect(await pending).toBeNull();
    expect(realtime.realtimeMetrics()).toEqual({ connections: 0, channels: 0 });
  });

  it('coalesces initial reads and broadcasts one absolute snapshot per channel to every subscriber', async () => {
    let resolveInitial!: (value: CounterSnapshot) => void;
    getCounterSnapshot.mockImplementationOnce(() => new Promise<CounterSnapshot>((resolve) => {
      resolveInitial = resolve;
    }));
    const requests = Array.from({ length: 3 }, () => realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    expect(getCounterSnapshot).toHaveBeenCalledExactlyOnceWith(eventId, true);
    resolveInitial(snapshot());
    const responses = await Promise.all(requests);
    const readers = responses.map(readerFor);
    expect(realtime.realtimeMetrics()).toEqual({ connections: 3, channels: 1 });
    expect(vi.getTimerCount()).toBe(1);
    const initial = await Promise.all(readers.map(readSnapshot));
    expect(initial.map((value) => value.total)).toEqual(['5', '5', '5']);

    const next = snapshot({
      total: '90071992547409930', revision: '90071992547409931',
      nationalTotal: '90071992547409935', nationalRevision: '90071992547409936',
      metadataVersion: 2, eventStatus: 'paused', serverTime: '2026-10-16T13:00:03.000Z'
    });
    getCounterSnapshot.mockResolvedValue(next);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getCounterSnapshot).toHaveBeenCalledTimes(2);
    const frames = await Promise.all(readers.map(readSnapshot));
    expect(frames).toEqual([next, next, next]);
    // Reading frames never queries the database and no per-client interval is created.
    expect(getCounterSnapshot).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    for (const controller of abortControllers) controller.abort();
    for (const reader of readers) expect((await reader.read()).done).toBe(true);
    expect(realtime.realtimeMetrics().connections).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up subscriptions, abort listeners and the last timer on abort or reader cancellation', async () => {
    getCounterSnapshot.mockResolvedValue(snapshot());
    const firstSignal = signal();
    const removeAbortListener = vi.spyOn(firstSignal, 'removeEventListener');
    const first = readerFor(await realtime.counterStream(eventId, firstSignal, 'realtime-test-peer'));
    await readSnapshot(first);
    abortControllers[0]!.abort();
    expect((await first.read()).done).toBe(true);
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(realtime.realtimeMetrics().connections).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const second = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    await readSnapshot(second);
    // A fresh public snapshot is reusable for a new connection without a new DB read.
    expect(getCounterSnapshot).toHaveBeenCalledTimes(1);
    await second.cancel();
    expect(realtime.realtimeMetrics().connections).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(getCounterSnapshot).toHaveBeenCalledTimes(1);
  });

  it('admits no subscription or scheduler for an already aborted request', async () => {
    getCounterSnapshot.mockResolvedValue(snapshot());
    const aborted = signal();
    abortControllers[0]!.abort();
    const reader = readerFor(await realtime.counterStream(eventId, aborted, 'realtime-test-peer'));
    expect((await reader.read()).done).toBe(true);
    expect(realtime.realtimeMetrics().connections).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes all affected subscribers after a DB failure without exposing an error frame', async () => {
    getCounterSnapshot.mockResolvedValueOnce(snapshot());
    const first = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    const second = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    await Promise.all([readSnapshot(first), readSnapshot(second)]);
    getCounterSnapshot.mockRejectedValueOnce(new Error('SQL failure containing private diagnostics'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getCounterSnapshot).toHaveBeenCalledTimes(2);
    expect(await first.read()).toEqual({ value: undefined, done: true });
    expect(await second.read()).toEqual({ value: undefined, done: true });
    expect(realtime.realtimeMetrics().connections).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap database refreshes while a previous scheduler tick is still pending', async () => {
    getCounterSnapshot.mockResolvedValueOnce(snapshot());
    const reader = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    await readSnapshot(reader);
    let resolveRefresh!: (value: CounterSnapshot) => void;
    getCounterSnapshot.mockImplementationOnce(() => new Promise<CounterSnapshot>((resolve) => {
      resolveRefresh = resolve;
    }));
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(getCounterSnapshot).toHaveBeenCalledTimes(2);
    const next = snapshot({ total: '6', revision: '6' });
    resolveRefresh(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(await readSnapshot(reader)).toEqual(next);
  });

  it('disconnects a slow consumer instead of accumulating snapshots in memory', async () => {
    getCounterSnapshot.mockResolvedValue(snapshot());
    const reader = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    // The first frame fills the queue. The consumer deliberately does not read it before the tick.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(realtime.realtimeMetrics().connections).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((await readSnapshot(reader)).total).toBe('5');
    expect((await reader.read()).done).toBe(true);
  });

  it('returns no stream or retained channel for a missing event', async () => {
    getCounterSnapshot.mockResolvedValue(null);
    expect(await realtime.counterStream(eventId, signal(), 'realtime-test-peer')).toBeNull();
    expect(realtime.realtimeMetrics()).toEqual({ connections: 0, channels: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires an idle mode-keyed channel while another channel keeps the scheduler active', async () => {
    const activeEventId = 'ddcc5b1e-3916-4d2e-9434-c25edbfb44d8';
    getCounterSnapshot.mockImplementation(async (id: string) => snapshot({ eventId: id }));
    const idle = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    const active = readerFor(await realtime.counterStream(activeEventId, signal(), 'realtime-test-peer'));
    await Promise.all([readSnapshot(idle), readSnapshot(active)]);
    abortControllers[0]!.abort();
    expect(realtime.realtimeMetrics()).toEqual({ connections: 1, channels: 2 });
    for (let tick = 0; tick < 11; tick++) {
      await vi.advanceTimersByTimeAsync(3_000);
      await readSnapshot(active);
    }
    expect(realtime.realtimeMetrics()).toEqual({ connections: 1, channels: 1 });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not reuse a fresh test snapshot for a new real-mode stream', async () => {
    getCounterSnapshot.mockResolvedValueOnce(snapshot());
    const testReader = readerFor(await realtime.counterStream(eventId, signal(), 'realtime-test-peer'));
    expect((await readSnapshot(testReader)).total).toBe('5');
    vi.stubEnv('REAL_EVENTS_APPROVED', 'true');
    getCounterSnapshot.mockResolvedValueOnce(null);
    expect(await realtime.counterStream(eventId, signal(), 'realtime-test-peer')).toBeNull();
    expect(getCounterSnapshot.mock.calls).toEqual([[eventId, true], [eventId, false]]);
    expect(realtime.realtimeMetrics()).toEqual({ connections: 1, channels: 1 });
  });
});
