export function workPrefix(token: string): Uint8Array {
  return new TextEncoder().encode(`jemecompte:admission:v1\0${token}\0`);
}
export function nonceBytes(nonce: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, nonce);
  return bytes;
}
export function sufficientWork(hash: Uint8Array, bits: number): boolean {
  for (let i = 0; i < Math.floor(bits / 8); i++) if (hash[i] !== 0) return false;
  const remainder = bits % 8;
  return remainder === 0 || (hash[Math.floor(bits / 8)]! >>> (8 - remainder)) === 0;
}
