import { describe, expect, it } from 'vitest';
import { TemporaryLimiter, TemporaryPeerCapacity, acquireWriteSlot } from '../../src/lib/server/abuse';

describe('temporary abuse controls', () => {
  it('limits repeated identities without treating a shared IP as one person', () => {
    const limiter = new TemporaryLimiter();
    for (let i = 0; i < 120; i++) expect(limiter.allow('peer', 'event', 'shared-IP', 1_000)).toBe(true);
    expect(limiter.allow('peer', 'event', 'shared-IP', 1_000)).toBe(false);
    for (let i = 0; i < 10; i++) expect(limiter.allow('identity', 'event', 'same-id', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'same-id', 1_000)).toBe(false);
    expect(limiter.allow('identity', 'other-event', 'same-id', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'same-id', 61_000)).toBe(true);
  });
  it('bounds identity memory without denying all new identities and expires buckets', () => {
    const limiter = new TemporaryLimiter(2);
    expect(limiter.allow('identity', 'event', 'a', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'b', 1_000)).toBe(true);
    expect(limiter.allow('identity', 'event', 'c', 1_000)).toBe(true);
    expect(limiter.size).toBe(2);
    expect(limiter.allow('identity', 'event', 'c', 65_000)).toBe(true);
    expect(limiter.size).toBe(1);
  });
  it('keeps identity floods out of network budgets and limits a peer across event changes', () => {
    const limiter = new TemporaryLimiter(500);
    for (let i = 0; i < 1_000; i++) expect(limiter.allow('identity', 'event', String(i), 1_000)).toBe(true);
    for (let i = 0; i < 240; i++) expect(limiter.allow('peer', `event-${i}`, 'shared-IP', 1_000)).toBe(true);
    expect(limiter.allow('peer', 'another-event', 'shared-IP', 1_000)).toBe(false);
    expect(limiter.allow('peer', 'event', 'another-IP', 1_000)).toBe(true);
  });
  it('isolates cache exhaustion between independent read and admission limiters', () => {
    const reads = new TemporaryLimiter(1);
    const writes = new TemporaryLimiter(1);
    expect(reads.allow('peer', 'event', 'spectator-network', 1_000)).toBe(true);
    expect(reads.allow('peer', 'event', 'new-network', 1_000)).toBe(false);
    expect(writes.allow('peer', 'event', 'new-network', 1_000)).toBe(true);
    expect(writes.allow('peer', 'event', 'spectator-network', 1_000)).toBe(false);
    expect(reads.allow('peer', 'event', 'spectator-network', 1_000)).toBe(true);
  });
  it('enforces the minute budget even when requests fit the short burst window', () => {
    const limiter = new TemporaryLimiter();
    for (let second = 1; second <= 15; second++) {
      for (let i = 0; i < 120; i++) expect(limiter.allow('peer', 'event', 'shared-IP', second * 1_000)).toBe(true);
    }
    expect(limiter.allow('peer', 'event', 'shared-IP', 16_000)).toBe(false);
    expect(limiter.allow('peer', 'other-event', 'shared-IP', 16_000)).toBe(true);
    expect(limiter.allow('peer', 'event', 'shared-IP', 61_000)).toBe(true);
  });
  it('bounds concurrent work per network, cleans up HMAC keys, and releases only once', () => {
    const capacity = new TemporaryPeerCapacity(3, 2);
    const first = capacity.acquire('PRIVATE_NETWORK_SENTINEL');
    const second = capacity.acquire('PRIVATE_NETWORK_SENTINEL');
    expect(() => capacity.acquire('PRIVATE_NETWORK_SENTINEL')).toThrow();
    const other = capacity.acquire('another-peer');
    expect(() => capacity.acquire('third-peer')).toThrow();
    expect(JSON.stringify(capacity)).not.toContain('PRIVATE_NETWORK_SENTINEL');
    first(); first(); second(); other();
    expect(capacity.size).toBe(0);
    capacity.acquire('new-peer')();
    expect(capacity.size).toBe(0);
  });
  it('shares IPv6 rate budgets within one /64 and canonicalizes IPv4-mapped addresses', () => {
    const limiter = new TemporaryLimiter();
    for (let i = 0; i < 120; i++) {
      expect(limiter.allow('peer', 'event', `2001:db8:1234:5678::${i.toString(16)}`, 1_000)).toBe(true);
    }
    expect(limiter.allow('peer', 'event', '2001:0DB8:1234:5678:ffff:ffff:ffff:ffff', 1_000)).toBe(false);
    expect(limiter.allow('peer', 'event', '2001:db8:1234:5679::1', 1_000)).toBe(true);
    for (let i = 0; i < 120; i++) expect(limiter.allow('peer', 'event', '192.0.2.1', 1_000)).toBe(true);
    expect(limiter.allow('peer', 'event', '::ffff:192.0.2.1', 1_000)).toBe(false);
    expect(limiter.allow('peer', 'event', '0:0:0:0:0:FFFF:C000:0201', 1_000)).toBe(false);
    expect(limiter.allow('peer', 'event', '192.0.2.2', 1_000)).toBe(true);
  });
  it('shares IPv6 concurrency reservations and releases aliases against the same budget', () => {
    const capacity = new TemporaryPeerCapacity(4, 1);
    const first = capacity.acquire('2001:db8:1234:5678::1');
    expect(() => capacity.acquire('2001:0db8:1234:5678::2')).toThrow();
    const other = capacity.acquire('2001:db8:1234:5679::1');
    first();
    const alias = capacity.acquire('2001:db8:1234:5678:ffff:ffff:ffff:ffff');
    const mapped = capacity.acquire('::ffff:192.0.2.1');
    expect(() => capacity.acquire('192.0.2.1')).toThrow();
    alias(); other(); mapped();
    expect(capacity.size).toBe(0);
    capacity.acquire('192.0.2.1')();
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
