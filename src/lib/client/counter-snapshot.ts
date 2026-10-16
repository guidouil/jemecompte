import type { CounterSnapshot } from '../shared/types';

const decimal = /^(0|[1-9][0-9]{0,39})$/;
const statuses = new Set(['draft', 'published', 'paused', 'closed', 'cancelled']);
const integrityStatuses = new Set(['normal', 'anomaly', 'suspended']);

export function parseCounterSnapshot(value: unknown): CounterSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.eventId !== 'string' ||
    typeof snapshot.day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.day) ||
    !['total', 'revision', 'nationalTotal', 'nationalRevision', 'cityTotal', 'cityRevision', 'epoch'].every(
      (key) => typeof snapshot[key] === 'string' && decimal.test(snapshot[key] as string)
    ) ||
    BigInt(snapshot.epoch as string) < 1n ||
    !['serverTime', 'startsAt', 'endsAt'].every(
      (key) => typeof snapshot[key] === 'string' && Number.isFinite(Date.parse(snapshot[key] as string))
    ) ||
    !Number.isSafeInteger(snapshot.metadataVersion) ||
    (snapshot.metadataVersion as number) < 1 ||
    !statuses.has(snapshot.eventStatus as string) ||
    !integrityStatuses.has(snapshot.integrityStatus as string)
  ) {
    return;
  }
  return value as CounterSnapshot;
}

/** Merge independent revisions, so metadata-only changes and justified counter decreases survive. */
export function mergeCounterSnapshots(
  current: CounterSnapshot | undefined,
  incoming: CounterSnapshot
): CounterSnapshot {
  if (!current || current.eventId !== incoming.eventId) return incoming;
  if (BigInt(incoming.epoch) < BigInt(current.epoch)) return current;
  if (BigInt(incoming.epoch) > BigInt(current.epoch)) return incoming;

  const merged = { ...current };
  if (BigInt(incoming.revision) > BigInt(current.revision)) {
    merged.total = incoming.total;
    merged.revision = incoming.revision;
  }
  if (incoming.day > current.day) {
    merged.day = incoming.day;
    merged.nationalTotal = incoming.nationalTotal;
    merged.nationalRevision = incoming.nationalRevision;
    merged.cityTotal = incoming.cityTotal;
    merged.cityRevision = incoming.cityRevision;
  } else if (incoming.day === current.day) {
    if (BigInt(incoming.nationalRevision) > BigInt(current.nationalRevision)) {
      merged.nationalTotal = incoming.nationalTotal;
      merged.nationalRevision = incoming.nationalRevision;
    }
    if (BigInt(incoming.cityRevision) > BigInt(current.cityRevision)) {
      merged.cityTotal = incoming.cityTotal;
      merged.cityRevision = incoming.cityRevision;
    }
  }
  if (incoming.metadataVersion > current.metadataVersion) {
    merged.eventStatus = incoming.eventStatus;
    merged.integrityStatus = incoming.integrityStatus;
    merged.metadataVersion = incoming.metadataVersion;
    merged.startsAt = incoming.startsAt;
    merged.endsAt = incoming.endsAt;
  }
  if (Date.parse(incoming.serverTime) > Date.parse(current.serverTime)) {
    merged.serverTime = incoming.serverTime;
  }
  return merged;
}
