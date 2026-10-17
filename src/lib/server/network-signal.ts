import { isIP } from 'node:net';

/** Temporary abuse-budget scope only: no DNS, persistence or device fingerprint.
 * IPv6 privacy addresses within one /64 share a budget. IPv4-mapped IPv6 uses
 * exactly the same budget as its IPv4 spelling. */
export function networkSignal(signal: string): string {
  if (isIP(signal) !== 6) return signal;
  let address = signal.split('%')[0]!.toLowerCase();
  const dottedTail = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedTail) {
    const octets = dottedTail[1]!.split('.').map(Number);
    address = address.slice(0, -dottedTail[1]!.length) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [left, right] = address.split('::');
  const leading = left ? left.split(':') : [];
  const trailing = right ? right.split(':') : [];
  const expanded = right === undefined ? leading
    : [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing];
  const words = expanded.map((word) => Number.parseInt(word, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `${words[6]! >>> 8}.${words[6]! & 255}.${words[7]! >>> 8}.${words[7]! & 255}`;
  }
  return `ipv6:${words.slice(0, 4).map((word) => word.toString(16).padStart(4, '0')).join(':')}::/64`;
}
