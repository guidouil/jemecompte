import { webcrypto, createHmac } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseLocalIdentity, getDailySupportIdentity, getEventIdentity } from '../../src/lib/client/identity';

const eventA = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
const eventB = '3e3f5fe8-fb22-4e7b-8c24-ef448fb57ee8';

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('jemecompte-identity', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('identity');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('local event identity', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('crypto', webcrypto);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('persists one non-exportable key across concurrent first actions and separates events', async () => {
    const identities = await Promise.all(Array.from({ length: 20 }, () => getEventIdentity(eventA)));
    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getEventIdentity(eventA)).toBe(identities[0]);
    expect(await getEventIdentity(eventB)).not.toBe(identities[0]);

    const database = await openIdentityDatabase();
    const record = await new Promise<{ key: CryptoKey }>((resolve) => {
      const request = database.transaction('identity').objectStore('identity').get('master-v1');
      request.onsuccess = () => resolve(request.result);
    });
    database.close();
    expect(record.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', record.key)).rejects.toThrow();
  });

  it('matches the canonical HMAC protocol for a known secret', async () => {
    const secret = new Uint8Array(32).fill(0x0b);
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const database = await openIdentityDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('identity', 'readwrite');
      transaction.objectStore('identity').put({ key, createdAt: Date.now() }, 'master-v1');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    const expected = createHmac('sha256', secret)
      .update(`jemecompte.fr\0presence:v1\0${eventA}`)
      .digest('base64url');
    expect(await getEventIdentity(eventA)).toBe(expected);
  });

  it('does not rotate automatically but explicit erasure changes the identity', async () => {
    const first = await getEventIdentity(eventA);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 400 * 86_400_000);
    expect(await getEventIdentity(eventA)).toBe(first);
    await eraseLocalIdentity();
    expect(await getEventIdentity(eventA)).not.toBe(first);
    vi.restoreAllMocks();
  });

  it('scopes support deduplication to one day without reusing event identifiers', async () => {
    const day = '2026-10-17';
    const tokens = await Promise.all(Array.from({ length: 10 }, () => getDailySupportIdentity(day)));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getDailySupportIdentity('2026-10-18')).not.toBe(tokens[0]);
    expect(await getEventIdentity(eventA)).not.toBe(tokens[0]);
    expect(await getEventIdentity(eventB)).not.toBe(tokens[0]);
    await eraseLocalIdentity();
    expect(await getDailySupportIdentity(day)).not.toBe(tokens[0]);
  });

  it('uses a separate support-day HMAC domain and rejects invalid days', async () => {
    const secret = new Uint8Array(32).fill(0x0b);
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const database = await openIdentityDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('identity', 'readwrite');
      transaction.objectStore('identity').put({ key, createdAt: Date.now() }, 'master-v1');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    expect(await getDailySupportIdentity('2026-10-17')).toBe(createHmac('sha256', secret)
      .update('jemecompte.fr\0support-day:v1\0' + '2026-10-17').digest('base64url'));
    for (const day of ['2026-02-30', '2026-10-17T00:00:00Z', '2026-13-01', '2026-1-1']) {
      await expect(getDailySupportIdentity(day)).rejects.toMatchObject({ code: 'invalid_day' });
    }
  });

  it('rejects unavailable storage and non-canonical event IDs without volatile fallback', async () => {
    await expect(getEventIdentity(eventA.toUpperCase())).rejects.toMatchObject({ code: 'invalid_event' });
    vi.stubGlobal('indexedDB', undefined);
    await expect(getEventIdentity(eventA)).rejects.toMatchObject({ code: 'storage_unavailable' });
  });
});
