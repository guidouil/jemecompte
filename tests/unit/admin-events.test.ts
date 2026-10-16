import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), invalidate: vi.fn(), close: vi.fn(), committed: false }));
vi.mock('../../src/lib/server/db', async (original) => ({
  ...await original<typeof import('../../src/lib/server/db')>(),
  adminTransaction: mocks.transaction, getAdminPool: () => ({ query: mocks.query })
}));
vi.mock('../../src/lib/server/public-data', () => ({ invalidatePublicEvent: mocks.invalidate }));
vi.mock('../../src/lib/server/realtime', () => ({ closeEventStreams: mocks.close }));
import { deleteAdminEvent, listAdminEvents } from '../../src/lib/server/admin-events';

const eventId = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const slug = 'comptage-fictif';
const actor = { operator: 'admin-unit', reason: 'Suppression fictive vérifiée' };

beforeEach(() => {
  mocks.committed = false;
  for (const mock of [mocks.transaction, mocks.query, mocks.invalidate, mocks.close]) mock.mockReset();
  mocks.transaction.mockImplementation(async (operation) => {
    const result = await operation({ query: mocks.query });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    mocks.committed = true;
    return result;
  });
});

describe('private administrative event service', () => {
  it('requires an actor and exact slug without invalidating anything on a failed confirmation', async () => {
    await expect(deleteAdminEvent(eventId, slug, { operator: '', reason: '' })).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue({ rows: [{ id: eventId, slug }] });
    expect(await deleteAdminEvent(eventId, ` ${slug}`, actor)).toEqual({ status: 'confirmation_mismatch' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('returns not_found for an invalid or absent UUID without exposing event details', async () => {
    expect(await deleteAdminEvent('invalid', slug, actor)).toEqual({ status: 'not_found' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await deleteAdminEvent(eventId, slug, actor)).toEqual({ status: 'not_found' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('publishes invalidation only after commit and audits aggregate deletion counts without selecting participant IDs', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: eventId, slug }] })
      .mockResolvedValueOnce({ rows: [{ total: '90071992547409930' }] })
      .mockResolvedValueOnce({ rows: [{ total: '2' }] })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValue({ rowCount: 1 });
    mocks.invalidate.mockImplementation(() => expect(mocks.committed).toBe(true));
    mocks.close.mockImplementation(() => expect(mocks.committed).toBe(true));
    expect(await deleteAdminEvent(eventId, slug, actor)).toEqual({
      status: 'deleted', eventId, slug, removedCount: '90071992547409930', deletedPresences: '2', deletedCounterRows: 3, detachedAuditRows: 4
    });
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(eventId);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(eventId);
    const queries = mocks.query.mock.calls.map(([query]) => query as string);
    expect(queries.join('\n')).not.toContain('anonymous_event_id');
    expect(queries[0]).toContain('FOR UPDATE');
    const audit = mocks.query.mock.calls.at(-1)!;
    expect(audit[0]).toContain("VALUES(NULL,$1,'delete_event'");
    expect(JSON.parse(audit[1][2])).toEqual({
      deletedEventId: eventId, slug, removedCount: '90071992547409930', deletedPresences: '2', deletedCounterRows: 3
    });
  });

  it('does not publish cache or stream invalidation when the transaction fails', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('Synthetic rollback'));
    await expect(deleteAdminEvent(eventId, slug, actor)).rejects.toThrow('Synthetic rollback');
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('paginates summaries and treats search as a parameter without returning unexpected private columns', async () => {
    const row = {
      id: eventId, slug, name: 'Comptage fictif', city_name: 'Ville fictive', status: 'closed', is_test: false,
      counting_scope: 'city', starts_at: new Date('2026-10-17T05:00:00Z'), ends_at: new Date('2026-10-17T17:00:00Z'),
      total_count: '42', retained_presences: '0', geofence: 'PRIVATE_SENTINEL', anonymous_event_id: 'PRIVATE_SENTINEL'
    };
    mocks.query.mockResolvedValue({ rows: Array.from({ length: 41 }, () => row) });
    const result = await listAdminEvents({ page: 2, q: '  100%_literal  ' });
    expect(result).toMatchObject({ page: 2, pageSize: 40, hasNext: true });
    expect(result.events).toHaveLength(40);
    expect(result.events[0]).toMatchObject({ totalCount: '42', retainedPresences: '0', countingScope: 'city', isTest: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(mocks.query.mock.calls[0]![1]).toEqual(['100%_literal', 41, 40]);
    expect(mocks.query.mock.calls[0]![0]).not.toContain('100%_literal');
  });
});
