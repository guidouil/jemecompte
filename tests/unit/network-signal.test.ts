import { describe, expect, it } from 'vitest';
import { networkSignal } from '../../src/lib/server/network-signal';

describe('temporary network budget normalization', () => {
  it.each([
    ['2001:db8:1234:5678::1', 'ipv6:2001:0db8:1234:5678::/64'],
    ['2001:0DB8:1234:5678:ABCD:1234:0000:0001', 'ipv6:2001:0db8:1234:5678::/64'],
    ['2001:db8::', 'ipv6:2001:0db8:0000:0000::/64'],
    ['::1', 'ipv6:0000:0000:0000:0000::/64'],
    ['fe80::1%en0', 'ipv6:fe80:0000:0000:0000::/64'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::ffff:c000:201', '192.0.2.1'],
    ['0:0:0:0:0:ffff:c000:0201', '192.0.2.1'],
    ['192.0.2.1', '192.0.2.1'],
    ['synthetic-peer', 'synthetic-peer'],
    ['not:an:ipv6:address', 'not:an:ipv6:address']
  ])('normalizes %s without resolving a hostname', (signal, expected) => {
    expect(networkSignal(signal)).toBe(expected);
  });
});
