import { createHmac, randomBytes } from 'node:crypto';

/** Creation limits are separate from participant limits; no participant identifier is accepted. */
export class CreationLimiter {
  private secret = randomBytes(32);
  private expiresAt = 0;
  private total = 0;
  private peers = new Map<string, number>();

  constructor(private readonly capacity = 128) {}

  allow(signal: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
    if (now >= this.expiresAt) {
      this.secret = randomBytes(32);
      this.expiresAt = now + 60 * 60_000;
      this.total = 0;
      this.peers.clear();
    }
    const retryAfter = Math.max(1, Math.ceil((this.expiresAt - now) / 1000));
    if (this.total >= 100) return { allowed: false, retryAfter };
    const key = createHmac('sha256', this.secret).update(signal).digest('base64url');
    const previous = this.peers.get(key) ?? 0;
    if (previous >= 10 || (!this.peers.has(key) && this.peers.size >= this.capacity)) {
      return { allowed: false, retryAfter };
    }
    this.peers.set(key, previous + 1);
    this.total++;
    return { allowed: true, retryAfter };
  }

  get size(): number { return this.peers.size; }
}

export const creationLimiter = new CreationLimiter();
