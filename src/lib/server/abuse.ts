import { createHmac, randomBytes } from 'node:crypto';

interface Bucket { count: number; expiresAt: number }
/** Process-local, bounded, non-persistent. No raw IP or participant ID is a map key. */
export class TemporaryLimiter {
  private secret = randomBytes(32);
  private secretExpiresAt = 0;
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly capacity = 20_000) {}

  allow(kind: 'peer' | 'identity', eventId: string, signal: string, now = Date.now()): boolean {
    if (now >= this.secretExpiresAt) {
      this.secret = randomBytes(32);
      this.secretExpiresAt = now + 60 * 60_000;
      this.buckets.clear();
    }
    if (now - this.lastSweep > 5_000) {
      for (const [key, bucket] of this.buckets) {
        if (bucket.expiresAt <= now) this.buckets.delete(key);
      }
      this.lastSweep = now;
    }
    const window = kind === 'identity' ? 60_000 : 1_000;
    const limit = kind === 'identity' ? 10 : 3_000;
    const key = createHmac('sha256', this.secret)
      .update(kind).update('\0').update(eventId).update('\0')
      .update(String(Math.floor(now / window))).update('\0').update(signal).digest('base64url');
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.capacity) return false;
      bucket = { count: 0, expiresAt: (Math.floor(now / window) + 1) * window };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count <= limit;
  }

  get size(): number { return this.buckets.size; }
}

export const limiter = new TemporaryLimiter();
let inflight = 0;
export function acquireWriteSlot(): (() => void) | null {
  if (inflight >= 128) return null;
  inflight++;
  let released = false;
  return () => { if (!released) { released = true; inflight--; } };
}

let activeReads = 0;
export class ReadCapacityError extends Error {}
export async function withReadBudget<T>(work: () => Promise<T>): Promise<T> {
  if (activeReads >= 128) throw new ReadCapacityError();
  activeReads++;
  try { return await work(); }
  finally { activeReads--; }
}
