import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrityMetrics, recordAdmissionEvent } from '../../src/lib/server/integrity-metrics';

const mocked = vi.hoisted(() => ({ pool: vi.fn(() => ({ totalCount: 1, idleCount: 1, waitingCount: 0 })) }));
vi.mock('../../src/lib/server/db/index', () => ({ getPool: mocked.pool }));
vi.mock('../../src/lib/server/realtime', () => ({ realtimeMetrics: () => ({ connections: 0, channels: 0 }) }));
import { GET } from '../../src/routes/internal/metrics/+server';

const eventId = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const secondId = 'ddcc5b1e-3916-4d2e-9434-c25edbfb44d8';
const thirdId = '982713de-20e8-4565-af3a-1fa653621c55';
const instances: IntegrityMetrics[] = [];
function telemetry(capacity?: number): IntegrityMetrics {
  const instance = new IntegrityMetrics(capacity);
  instances.push(instance);
  return instance;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  vi.clearAllTimers(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.clearAllMocks();
});

describe('bounded event integrity aggregates', () => {
  it('stores only fixed per-minute aggregates and flags accepted action rates for review', () => {
    const metrics = telemetry();
    for (let i = 0; i < 119; i++) metrics.record(eventId, 'presence', 1_000);
    metrics.record(eventId, 'support', 1_000);
    metrics.record(eventId, 'conversion', 1_000);
    metrics.record(eventId, 'proof_rejected', 1_000);
    metrics.record(eventId, 'challenge_issued', 1_000);
    metrics.record('PRIVATE_PARTICIPANT_SENTINEL', 'presence', 1_000);
    const snapshot = metrics.snapshot(1_000);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ eventId, review: true, minutes: [{
      presence: 119, support: 1, conversion: 1, proof_rejected: 1, challenge_issued: 1,
      acceptedActions: 120, review: true
    }] });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_PARTICIPANT_SENTINEL');
    snapshot.events[0]!.minutes[0]!.presence = 999;
    expect(metrics.snapshot(1_000).events[0]!.minutes[0]!.presence).toBe(119);
  });

  it('expires minute buckets after ten minutes and bounds event memory without rejecting activity', () => {
    const metrics = telemetry(2);
    metrics.record(eventId, 'presence', 1_000);
    metrics.record(secondId, 'support', 1_000);
    metrics.record(eventId, 'presence', 1_000);
    metrics.record(thirdId, 'support', 1_000);
    const snapshot = metrics.snapshot(1_000);
    expect(snapshot.events.map((entry) => entry.eventId)).toEqual([eventId, thirdId]);
    expect(snapshot.evictions).toBe(1);
    expect(metrics.snapshot(600_000).events).toEqual([]);
    for (let minute = 1; minute <= 15; minute++) metrics.record(eventId, 'presence', minute * 60_000);
    expect(metrics.snapshot(900_000).events[0]!.minutes).toHaveLength(10);
  });

  it('accepts only a bounded server-side threshold and treats proof failures as a separate signal', () => {
    const metrics = telemetry();
    for (let i = 0; i < 20; i++) metrics.record(eventId, 'proof_rejected', 1_000);
    expect(metrics.snapshot(1_000).events[0]!.review).toBe(false);
    vi.stubEnv('INTEGRITY_REVIEW_PER_MINUTE', '10');
    for (let i = 0; i < 10; i++) metrics.record(eventId, 'support', 1_000);
    expect(metrics.snapshot(1_000)).toMatchObject({ reviewThresholdPerMinute: 10, events: [{ review: true }] });
    for (const invalid of ['0', '1', '-2', '100001', 'Infinity', 'nonsense']) {
      vi.stubEnv('INTEGRITY_REVIEW_PER_MINUTE', invalid);
      expect(metrics.snapshot(1_000).reviewThresholdPerMinute).toBe(120);
    }
  });

  it('expires idle aggregates at each oldest-bucket deadline with a single unreferenced timer', async () => {
    const metrics = telemetry();
    const sweep = vi.spyOn(metrics as unknown as { sweep: (minute: number) => void }, 'sweep');
    metrics.record(eventId, 'presence');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    metrics.record(secondId, 'support');
    expect(vi.getTimerCount()).toBe(1);
    sweep.mockClear();
    await vi.advanceTimersByTimeAsync(539_000);
    expect(sweep).toHaveBeenCalledExactlyOnceWith(10);
    expect(vi.getTimerCount()).toBe(1);
    sweep.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledExactlyOnceWith(11);
    expect(vi.getTimerCount()).toBe(0);
    expect(metrics.snapshot().events).toEqual([]);
    metrics.record(eventId, 'presence');
    expect(vi.getTimerCount()).toBe(1);
    metrics.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps event aggregates behind the existing metrics token and never opens the database before authorization', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    vi.stubEnv('METRICS_TOKEN', 'synthetic-metrics-secret');
    recordAdmissionEvent(eventId, 'challenge_issued');
    const request = (authorization?: string) => ({ request: new Request('https://example.invalid/internal/metrics', {
      headers: authorization ? { authorization } : {}
    }) }) as Parameters<typeof GET>[0];
    expect((await GET(request())).status).toBe(404);
    expect((await GET(request('Bearer incorrect-secret'))).status).toBe(404);
    expect(mocked.pool).not.toHaveBeenCalled();
    const response = await GET(request('Bearer synthetic-metrics-secret'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.integrity.events).toMatchObject([{ eventId, minutes: [{ challenge_issued: 1 }] }]);
    expect(JSON.stringify(body)).not.toContain('synthetic-metrics-secret');
    expect(mocked.pool).toHaveBeenCalledOnce();
  });
});
