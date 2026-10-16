import { describe, expect, it } from 'vitest';
import { TemporaryLimiter, acquireWriteSlot } from '../../src/lib/server/abuse';

describe('temporary abuse controls', () => {
  it('limits repeated identities without treating a shared IP as one person', () => {
    const limiter = new TemporaryLimiter();
    for (let i = 0; i < 2_000; i++) expect(limiter.allow('peer', 'event', 'shared-IP', 1_000)).toBe(true);
    for (let i = 0; i < 10; i++) expect(limiter.allow('identity', 'event', 'same-id', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'same-id', 1_000)).toBe(false);
    expect(limiter.allow('identity', 'other-event', 'same-id', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'same-id', 61_000)).toBe(true);
  });
  it('bounds memory and expires buckets', () => {
    const limiter = new TemporaryLimiter(2);
    expect(limiter.allow('identity', 'event', 'a', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'b', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'c', 1_000)).toBe(false);
    expect(limiter.size).toBe(2);
    expect(limiter.allow('identity', 'event', 'c', 65_000)).toBe(true);
    expect(limiter.size).toBe(1);
  });
  it('bounds write concurrency and releases only once', () => {
    const slots = Array.from({ length: 128 }, () => acquireWriteSlot());
    expect(slots.every(Boolean)).toBe(true);
    expect(acquireWriteSlot()).toBeNull();
    slots[0]?.(); slots[0]?.();
    const extra = acquireWriteSlot();
    expect(extra).not.toBeNull();
    expect(acquireWriteSlot()).toBeNull();
    extra?.();
    for (const slot of slots) slot?.();
  });
});
