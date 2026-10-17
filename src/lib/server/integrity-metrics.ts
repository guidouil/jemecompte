export type AdmissionEventKind = 'presence' | 'support' | 'conversion' | 'proof_rejected' | 'challenge_issued';
const MINUTE_MS = 60_000;
const RETAINED_MINUTES = 10;
const DEFAULT_REVIEW_THRESHOLD = 120;
const eventUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyCounts = () => ({ presence: 0, support: 0, conversion: 0, proof_rejected: 0, challenge_issued: 0 });
type Counts = ReturnType<typeof emptyCounts>;

function reviewThreshold(): number {
  const raw = process.env.INTEGRITY_REVIEW_PER_MINUTE ?? '';
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return DEFAULT_REVIEW_THRESHOLD;
  const value = Number(raw);
  return value >= 10 && value <= 100_000 ? value : DEFAULT_REVIEW_THRESHOLD;
}

/** Public event IDs and fixed minute aggregates only. Never accept participant,
 * network, challenge or payload fields here. This telemetry never gates admission. */
export class IntegrityMetrics {
  private events = new Map<string, Map<number, Counts>>();
  private lastSweepMinute = -1;
  private evictions = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly maximumEvents = 500) {}

  private scheduleExpiry(): void {
    if (this.expiryTimer || !this.events.size) return;
    let oldestMinute = Infinity;
    for (const buckets of this.events.values()) {
      const first = buckets.keys().next().value;
      if (first !== undefined) oldestMinute = Math.min(oldestMinute, first);
    }
    const deadline = (oldestMinute + RETAINED_MINUTES) * MINUTE_MS;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.sweep(Math.floor(Date.now() / MINUTE_MS));
      this.scheduleExpiry();
    }, Math.max(0, deadline - Date.now()));
    this.expiryTimer.unref();
  }

  private sweep(minute: number): void {
    for (const [eventId, buckets] of this.events) {
      for (const key of buckets.keys()) if (key <= minute - RETAINED_MINUTES || key > minute) buckets.delete(key);
      if (!buckets.size) this.events.delete(eventId);
    }
    this.lastSweepMinute = minute;
    if (!this.events.size && this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }

  record(eventId: string, kind: AdmissionEventKind, now = Date.now()): void {
    if (!eventUuid.test(eventId) || !Object.hasOwn(emptyCounts(), kind) || !Number.isFinite(now)) return;
    const minute = Math.floor(now / MINUTE_MS);
    if (this.lastSweepMinute !== minute) this.sweep(minute);
    const id = eventId.toLowerCase();
    let buckets = this.events.get(id);
    if (!buckets) {
      if (this.events.size >= this.maximumEvents) {
        const oldest = this.events.keys().next().value;
        if (oldest !== undefined) { this.events.delete(oldest); this.evictions++; }
      }
      buckets = new Map();
      this.events.set(id, buckets);
    } else {
      // Keep recent event activity when the bounded telemetry cache is full.
      this.events.delete(id);
      this.events.set(id, buckets);
    }
    let counts = buckets.get(minute);
    if (!counts) { counts = emptyCounts(); buckets.set(minute, counts); }
    counts[kind]++;
    this.scheduleExpiry();
  }

  snapshot(now = Date.now()) {
    const minute = Math.floor(now / MINUTE_MS);
    this.sweep(minute);
    const threshold = reviewThreshold();
    return {
      retentionMinutes: RETAINED_MINUTES,
      maximumEvents: this.maximumEvents,
      reviewThresholdPerMinute: threshold,
      evictions: this.evictions,
      events: [...this.events].map(([eventId, buckets]) => {
        const minutes = [...buckets].sort(([a], [b]) => a - b).map(([key, counts]) => ({
          minute: new Date(key * MINUTE_MS).toISOString(),
          ...counts,
          acceptedActions: counts.presence + counts.support,
          review: counts.presence + counts.support >= threshold
        }));
        return { eventId, review: minutes.some((bucket) => bucket.review), minutes };
      })
    };
  }

  /** Release the single expiry timer and aggregate memory, including in tests. */
  dispose(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.events.clear();
  }
}

const metrics = new IntegrityMetrics();
/** Count presence/support only after a new successful commit, never a retry.
 * Conversion is an optional subset of presence and does not add another admission. */
export function recordAdmissionEvent(eventId: string, kind: AdmissionEventKind): void { metrics.record(eventId, kind); }
export function admissionMetrics() { return metrics.snapshot(); }
