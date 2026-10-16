import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CounterSnapshot, PublicEvent } from '../../src/lib/shared/types';

const mocks = vi.hoisted(() => ({ list: vi.fn(), total: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../src/lib/server/events', () => ({ listPublicEvents: mocks.list }));
vi.mock('../../src/lib/server/counters', () => ({ getNationalTotal: mocks.total, getCounterSnapshot: mocks.snapshot }));

const id = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
let data: typeof import('../../src/lib/server/public-data');

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('REAL_EVENTS_APPROVED', 'false');
  mocks.list.mockReset();
  mocks.total.mockReset();
  mocks.snapshot.mockReset();
  data = await import('../../src/lib/server/public-data');
});
afterEach(() => vi.unstubAllEnvs());

describe('public data mode isolation', () => {
  it('invalidates all embedded aggregates after deletion, including a pre-deletion read still in flight', async () => {
    mocks.list.mockResolvedValue([{ id }] as PublicEvent[]);
    mocks.total.mockResolvedValue('8');
    mocks.snapshot.mockResolvedValue({ eventId: id, nationalTotal: '8' } as CounterSnapshot);
    await data.publicCatalogue();
    await data.publicNationalTotal();
    await data.publicCounterSnapshot(id);
    data.invalidatePublicEvent('a-different-deleted-event');
    mocks.list.mockResolvedValue([]);
    mocks.total.mockResolvedValue('0');
    mocks.snapshot.mockResolvedValue({ eventId: id, nationalTotal: '0' } as CounterSnapshot);
    expect(await data.publicCatalogue()).toEqual([]);
    expect(await data.publicNationalTotal()).toBe('0');
    expect((await data.publicCounterSnapshot(id))?.nationalTotal).toBe('0');
    data.invalidatePublicEvent(id);
    let finish!: (value: string) => void;
    mocks.total.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const stale = data.publicNationalTotal();
    data.invalidatePublicEvent(id);
    finish('9');
    await stale;
    expect(await data.publicNationalTotal()).toBe('0');
  });

  it('keeps catalogues, national totals and snapshots in separate caches when the public mode changes', async () => {
    const testEvents = [{ id: 'test' }] as PublicEvent[];
    const realEvents = [{ id: 'real' }] as PublicEvent[];
    const snapshot = { eventId: id, total: '3' } as CounterSnapshot;
    mocks.list.mockImplementation(async (isTest: boolean) => isTest ? testEvents : realEvents);
    mocks.total.mockImplementation(async (isTest: boolean) => isTest ? '3' : '29');
    mocks.snapshot.mockImplementation(async (_id: string, isTest: boolean) => isTest ? snapshot : null);

    expect(await data.publicCatalogue()).toBe(testEvents);
    expect(await data.publicNationalTotal()).toBe('3');
    expect(await data.publicCounterSnapshot(id)).toBe(snapshot);
    vi.stubEnv('REAL_EVENTS_APPROVED', 'true');
    expect(await data.publicCatalogue()).toBe(realEvents);
    expect(await data.publicNationalTotal()).toBe('29');
    expect(await data.publicCounterSnapshot(id)).toBeNull();
    vi.stubEnv('REAL_EVENTS_APPROVED', 'false');
    expect(await data.publicCatalogue()).toBe(testEvents);
    expect(await data.publicNationalTotal()).toBe('3');
    expect(await data.publicCounterSnapshot(id)).toBe(snapshot);
    expect(mocks.list.mock.calls).toEqual([[true], [false]]);
    expect(mocks.total.mock.calls).toEqual([[true, 'gathering'], [false, 'gathering']]);
    expect(mocks.snapshot.mock.calls).toEqual([[id, true], [id, false]]);
  });

  it('does not add or reuse city declarations in the national gathering total', async () => {
    mocks.total.mockImplementation(async (_isTest: boolean, scope: string) => scope === 'city' ? '47' : '3');
    expect(await data.publicNationalTotal()).toBe('3');
    expect(await data.publicNationalTotal('city')).toBe('47');
    expect(await data.publicNationalTotal()).toBe('3');
    expect(mocks.total.mock.calls).toEqual([[true, 'gathering'], [true, 'city']]);
  });

  it('does not reuse a test read still in flight for a newly activated real mode', async () => {
    let resolveTest!: (events: PublicEvent[]) => void;
    mocks.list.mockImplementation((isTest: boolean) => isTest
      ? new Promise<PublicEvent[]>((resolve) => { resolveTest = resolve; })
      : Promise.resolve([{ id: 'real' }] as PublicEvent[]));
    const pendingTest = data.publicCatalogue();
    vi.stubEnv('REAL_EVENTS_APPROVED', 'true');
    expect((await data.publicCatalogue())[0]?.id).toBe('real');
    resolveTest([{ id: 'test' }] as PublicEvent[]);
    await pendingTest;
    expect((await data.publicCatalogue())[0]?.id).toBe('real');
  });
});
