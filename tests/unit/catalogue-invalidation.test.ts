import { describe, expect, it, vi } from 'vitest';
import type { PublicEvent } from '../../src/lib/shared/types';

const mocked = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../src/lib/server/events', () => ({ listPublicEvents: mocked.list }));
import { invalidatePublicCatalogue, publicCatalogue } from '../../src/lib/server/public-data';

describe('catalogue invalidation after public creation', () => {
  it('does not let a slower older request replace the fresh cache after invalidation', async () => {
    let resolveOld!: (value: PublicEvent[]) => void;
    const previous = new Promise<PublicEvent[]>((resolve) => { resolveOld = resolve; });
    const fresh: PublicEvent[] = [];
    mocked.list.mockReturnValueOnce(previous).mockResolvedValueOnce(fresh);
    const oldRequest = publicCatalogue();
    invalidatePublicCatalogue();
    expect(await publicCatalogue()).toBe(fresh);
    resolveOld([]);
    await oldRequest;
    expect(await publicCatalogue()).toBe(fresh);
    expect(mocked.list).toHaveBeenCalledTimes(2);
  });
});
