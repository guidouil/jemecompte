import type { CounterSnapshot, PublicEvent } from '../shared/types';
import { getCounterSnapshot, getNationalTotal } from './counters';
import { listPublicEvents } from './events';

interface Entry<T> { value?: T; expiresAt: number; pending?: Promise<T>; generation?: number }
const catalogue: Entry<PublicEvent[]> = { expiresAt: 0 };
const national: Entry<string> = { expiresAt: 0 };
const snapshots = new Map<string, Entry<CounterSnapshot | null>>();

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
  catalogue.generation = (catalogue.generation ?? 0) + 1;
  catalogue.value = undefined;
  catalogue.pending = undefined;
  catalogue.expiresAt = 0;
}

export function publicCatalogue(): Promise<PublicEvent[]> {
  return cached(catalogue, 5_000, listPublicEvents);
}
export function publicNationalTotal(): Promise<string> {
  return cached(national, 3_000, () => getNationalTotal(true));
}
export function publicCounterSnapshot(eventId: string): Promise<CounterSnapshot | null> {
  let entry = snapshots.get(eventId);
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
    snapshots.set(eventId, entry);
  }
  return cached(entry, 3_000, () => getCounterSnapshot(eventId));
}
