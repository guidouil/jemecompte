import { createHmac, randomBytes } from 'node:crypto';
import { networkSignal } from './network-signal';

interface Window { duration: number; limit: number }
interface Bucket { counts: number[]; starts: number[]; expiresAt: number }
const peerWindows: Window[] = [{ duration: 1_000, limit: 120 }, { duration: 60_000, limit: 1_800 }];
const globalPeerWindows: Window[] = [{ duration: 1_000, limit: 240 }, { duration: 60_000, limit: 3_600 }];
const identityWindows: Window[] = [{ duration: 60_000, limit: 10 }];
/** Process-local, bounded and non-persistent. Keys never contain raw network or participant identifiers. */
export class TemporaryLimiter {
  private secret = randomBytes(32);
  private secretExpiresAt = 0;
  private peers = new Map<string, Bucket>();
  private globalPeers = new Map<string, Bucket>();
  private identities = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly capacity = 20_000) {}

  private key(kind: string, scope: string, signal: string): string {
    return createHmac('sha256', this.secret).update(kind).update('\0').update(scope).update('\0').update(signal).digest('base64url');
  }

  private consume(map: Map<string, Bucket>, key: string, windows: Window[], now: number, evict = false): boolean {
    let bucket = map.get(key);
    if (!bucket) {
      if (map.size >= this.capacity) {
        // Fresh identity strings must not deny every new participant. The
        // separate network budgets and admission proofs remain mandatory.
        if (!evict) return false;
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      bucket = { counts: windows.map(() => 0), starts: windows.map(({ duration }) => Math.floor(now / duration) * duration), expiresAt: 0 };
      map.set(key, bucket);
    }
    for (const [index, window] of windows.entries()) {
      const start = Math.floor(now / window.duration) * window.duration;
      if (bucket.starts[index] !== start) { bucket.starts[index] = start; bucket.counts[index] = 0; }
    }
    bucket.expiresAt = Math.max(...windows.map((window, index) => bucket.starts[index]! + window.duration));
    if (windows.some((window, index) => bucket.counts[index]! >= window.limit)) return false;
    bucket.counts = bucket.counts.map((count) => count + 1);
    return true;
  }

  allow(kind: 'peer' | 'identity', eventId: string, signal: string, now = Date.now()): boolean {
    if (now >= this.secretExpiresAt) {
      this.secret = randomBytes(32);
      this.secretExpiresAt = now + 60 * 60_000;
      this.peers.clear(); this.globalPeers.clear(); this.identities.clear();
    }
    if (now - this.lastSweep > 5_000) {
      for (const map of [this.peers, this.globalPeers, this.identities]) {
        for (const [key, bucket] of map) if (bucket.expiresAt <= now) map.delete(key);
      }
      this.lastSweep = now;
    }
    if (kind === 'identity') return this.consume(this.identities, this.key(kind, eventId, signal), identityWindows, now, true);
    const network = networkSignal(signal);
    // The global budget cannot be bypassed by varying event IDs or routes.
    // Burst room accommodates mobile-carrier and venue NATs without treating
    // their shared IP as a unique participant.
    if (!this.consume(this.globalPeers, this.key(kind, '*', network), globalPeerWindows, now)) return false;
    return this.consume(this.peers, this.key(kind, eventId, network), peerWindows, now);
  }

  get size(): number { return this.peers.size + this.globalPeers.size + this.identities.size; }
}

export const limiter = new TemporaryLimiter();
// Spectators falling back from SSE to polling must not consume admission
// budgets. Independent instances isolate both counters and cache capacity.
export const readLimiter = new TemporaryLimiter();

export class PeerCapacityError extends Error {
  constructor(public readonly kind: 'peer' | 'global') { super('Temporary capacity reached'); }
}

/** Only active leases retain a process-random HMAC; releasing the last one deletes its key. */
export class TemporaryPeerCapacity {
  private secret = randomBytes(32);
  private peers = new Map<string, number>();
  private active = 0;

  constructor(private readonly maximum: number, private readonly perPeer: number) {}

  acquire(signal: string): () => void {
    if (this.active >= this.maximum) throw new PeerCapacityError('global');
    const key = createHmac('sha256', this.secret).update(networkSignal(signal)).digest('base64url');
    const count = this.peers.get(key) ?? 0;
    if (count >= this.perPeer) throw new PeerCapacityError('peer');
    this.peers.set(key, count + 1);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const remaining = (this.peers.get(key) ?? 1) - 1;
      if (remaining) this.peers.set(key, remaining); else this.peers.delete(key);
      if (!this.active) this.secret = randomBytes(32);
    };
  }

  get size(): number { return this.peers.size; }
}

const parsingCapacity = new TemporaryPeerCapacity(128, 8);
export function acquireParsingSlot(signal: string): () => void { return parsingCapacity.acquire(signal); }
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
