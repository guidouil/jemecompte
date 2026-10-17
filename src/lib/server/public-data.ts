import type { CountingScope, CounterSnapshot, PublicEvent } from '../shared/types';
import { getCounterSnapshot, getNationalTotals, type NationalTotals } from './counters';
import { listPublicEvents } from './events';
import { realEventsApproved } from './db';

interface Entry<T> { value?: T; expiresAt: number; pending?: Promise<T>; generation?: number }
const catalogues = new Map<boolean, Entry<PublicEvent[]>>();
const nationals = new Map<string, Entry<NationalTotals>>();
const snapshots = new Map<string, Entry<CounterSnapshot | null>>();

function modeEntry<K, T>(entries: Map<K, Entry<T>>, key: K): Entry<T> {
  let entry = entries.get(key);
  if (!entry) {
    entry = { expiresAt: 0 };
    entries.set(key, entry);
  }
  return entry;
}

async function cached<T>(entry: Entry<T>, ttl: number, read: () => Promise<T>): Promise<T> {
  if (entry.value !== undefined && entry.expiresAt > Date.now()) return entry.value;
  if (entry.pending) return entry.pending;
  const generation = entry.generation;
  const pending = read();
  entry.pending = pending;
  try {
    const value = await pending;
    if (entry.generation === generation) {
      entry.value = value;
      entry.expiresAt = Date.now() + ttl;
    }
    return value;
  } finally { if (entry.pending === pending) entry.pending = undefined; }
}

export function invalidatePublicCatalogue(): void {
  for (const catalogue of catalogues.values()) {
    catalogue.generation = (catalogue.generation ?? 0) + 1;
    catalogue.value = undefined;
    catalogue.pending = undefined;
    catalogue.expiresAt = 0;
  }
}

/** Every snapshot embeds national/city totals, so a deletion invalidates all of them. */
export function invalidatePublicEvent(_eventId: string): void {
  invalidatePublicCatalogue();
  for (const entry of [...nationals.values(), ...snapshots.values()]) {
    entry.generation = (entry.generation ?? 0) + 1;
    entry.value = undefined;
    entry.pending = undefined;
    entry.expiresAt = 0;
  }
}

export function publicCatalogue(): Promise<PublicEvent[]> {
  const isTest = !realEventsApproved();
  return cached(modeEntry(catalogues, isTest), 5_000, () => listPublicEvents(isTest));
}
export function publicNationalTotal(countingScope: CountingScope = 'gathering'): Promise<string> {
  return publicNationalTotals(countingScope).then((totals) => totals.total);
}
export function publicNationalSupportTotal(countingScope: CountingScope = 'gathering'): Promise<string> {
  return publicNationalTotals(countingScope).then((totals) => totals.supportTotal);
}
export function publicNationalTotals(countingScope: CountingScope = 'gathering'): Promise<NationalTotals> {
  const isTest = !realEventsApproved();
  return cached(modeEntry(nationals, `${isTest}:${countingScope}`), 3_000,
    () => getNationalTotals(isTest, countingScope));
}
export function publicCounterSnapshot(eventId: string): Promise<CounterSnapshot | null> {
  const isTest = !realEventsApproved();
  const key = `${isTest}:${eventId}`;
  let entry = snapshots.get(key);
  if (!entry) {
    for (const [id, item] of snapshots) {
      if (!item.pending && item.expiresAt <= Date.now()) snapshots.delete(id);
    }
    if (snapshots.size >= 100) {
      const oldest = [...snapshots].find(([, item]) => !item.pending);
      if (oldest) snapshots.delete(oldest[0]);
      else return Promise.reject(new Error('Public snapshot capacity reached'));
    }
    entry = { expiresAt: 0 };
    snapshots.set(key, entry);
  }
  return cached(entry, 3_000, () => getCounterSnapshot(eventId, isTest));
}
