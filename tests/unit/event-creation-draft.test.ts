import { describe, expect, it } from 'vitest';
import { clearEventCreationDraft, EVENT_CREATION_DRAFT_KEY, EVENT_CREATION_DRAFT_TTL_MS,
  loadEventCreationDraft, saveEventCreationDraft } from '../../src/lib/client/event-creation-draft';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const payload = { requestId: '5a52252e-28ae-49f6-ab20-98805d61d094', name: 'Recette fictive',
  cityName: 'Paris', cityCode: '75056', publicCenter: [2.36, 48.86], radiusMeters: 500,
  durationMinutes: 240, startsAt: '2026-10-17T12:00:00.000Z', publicLocationConfirmed: true };

function memoryStorage() {
  const entries = new Map<string, string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); } };
}

describe('confirmed public creation draft', () => {
  it('restores the exact request and public schedule across reloads without extending its lifetime', () => {
    const storage = memoryStorage();
    expect(saveEventCreationDraft(payload, now, storage)).toEqual({ status: 'saved',
      draft: { version: 1, savedAt: now, payload } });
    expect(loadEventCreationDraft(now + 3_600_000, storage)).toEqual({ status: 'ready',
      draft: { version: 1, savedAt: now, payload } });
    expect(Object.keys(JSON.parse(storage.getItem(EVENT_CREATION_DRAFT_KEY)!)).sort()).toEqual(['payload', 'savedAt', 'version']);
  });

  it('keeps an immediate start absent so the server can replay the same request', () => {
    const storage = memoryStorage();
    const { startsAt: _start, ...immediate } = payload;
    expect(saveEventCreationDraft(immediate, now, storage).status).toBe('saved');
    expect(loadEventCreationDraft(now, storage)).toMatchObject({ status: 'ready', draft: { payload: immediate } });
    expect(JSON.parse(storage.getItem(EVENT_CREATION_DRAFT_KEY)!).payload).not.toHaveProperty('startsAt');
  });

  it.each(['anonymousEventId', 'latitude', 'longitude', 'accuracy', 'privateLocation', 'identity'])('rejects the private or unexpected property %s without writing it', (property) => {
    const storage = memoryStorage();
    expect(saveEventCreationDraft({ ...payload, [property]: 'private-sentinel' }, now, storage)).toEqual({ status: 'invalid' });
    expect(storage.entries.size).toBe(0);
  });

  it.each([{ ...payload, publicLocationConfirmed: false }, { ...payload, radiusMeters: 0 },
    { ...payload, startsAt: '2026-10-17T12:00:00' }, { ...payload, publicCenter: [2.36, Infinity] },
    { ...payload, durationMinutes: 5 }, { ...payload, requestId: 'not-a-request' }])('rejects an unconfirmed or damaged request', (invalid) => {
    const storage = memoryStorage();
    expect(saveEventCreationDraft(invalid, now, storage)).toEqual({ status: 'invalid' });
    expect(storage.entries.size).toBe(0);
  });

  it('expires and erases the saved public request after 24 hours, including at the boundary', () => {
    const storage = memoryStorage();
    saveEventCreationDraft(payload, now, storage);
    expect(loadEventCreationDraft(now + EVENT_CREATION_DRAFT_TTL_MS - 1, storage).status).toBe('ready');
    expect(loadEventCreationDraft(now + EVENT_CREATION_DRAFT_TTL_MS, storage)).toEqual({ status: 'expired' });
    expect(storage.getItem(EVENT_CREATION_DRAFT_KEY)).toBeNull();
    expect(loadEventCreationDraft(now + EVENT_CREATION_DRAFT_TTL_MS + 1, storage)).toEqual({ status: 'empty' });
  });

  it.each(['broken-json', JSON.stringify({ version: 2, savedAt: now, payload }),
    JSON.stringify({ version: 1, savedAt: now, payload: { ...payload, anonymousEventId: 'private-sentinel' } }),
    JSON.stringify({ version: 1, savedAt: now + 1, payload }),
    JSON.stringify({ version: 1, savedAt: now, payload, unexpected: 'private-sentinel' })])('discards an unreadable, incompatible or unsafe saved record', (raw) => {
    const storage = memoryStorage();
    storage.setItem(EVENT_CREATION_DRAFT_KEY, raw);
    expect(loadEventCreationDraft(now, storage)).toEqual({ status: 'invalid' });
    expect(storage.getItem(EVENT_CREATION_DRAFT_KEY)).toBeNull();
  });

  it('reports blocked storage while retaining the safe request for an in-memory retry', () => {
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); } };
    expect(saveEventCreationDraft(payload, now, blocked)).toEqual({ status: 'unavailable',
      draft: { version: 1, savedAt: now, payload } });
    expect(loadEventCreationDraft(now, blocked)).toEqual({ status: 'unavailable' });
    expect(clearEventCreationDraft(blocked)).toBe(false);
  });

  it('clears only the creation draft and preserves unrelated browser data', () => {
    const storage = memoryStorage();
    saveEventCreationDraft(payload, now, storage);
    storage.setItem('unrelated', 'keep');
    expect(clearEventCreationDraft(storage)).toBe(true);
    expect(storage.getItem(EVENT_CREATION_DRAFT_KEY)).toBeNull();
    expect(storage.getItem('unrelated')).toBe('keep');
  });
});
