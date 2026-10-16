import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventQr } from '../../src/lib/client/event-qr';

beforeEach(() => {
  vi.stubGlobal('location', {
    origin: 'https://jemecompte.fr',
    href: 'https://jemecompte.fr/?anonymousEventId=PRIVATE_ID#position=PRIVATE_POSITION'
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('locally generated event QR', () => {
  it('encodes only the canonical public link, independently of local identity, position and event metadata', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const clean = await createEventQr({ slug: 'rassemblement-public' });
    const privateEvent = {
      slug: 'rassemblement-public', anonymousEventId: 'PRIVATE_ID',
      coordinates: 'PRIVATE_POSITION', name: 'PRIVATE_NAME'
    };
    expect(await createEventQr(privateEvent)).toEqual(clean);
    expect(clean.url).toBe('https://jemecompte.fr/evenements/rassemblement-public');
    expect(clean.imageUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(clean.imageUrl.split(',')[1]!);
    expect(svg).toContain('<svg');
    expect(svg).toContain('fill="white"');
    expect(svg).toContain('fill="black"');
    expect(svg).not.toContain('PRIVATE_');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('href=');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the actual website origin without retaining its path, query or hash', async () => {
    expect((await createEventQr({ slug: 'autre-rassemblement' }, 'https://example.org/elsewhere?private=1#private')).url)
      .toBe('https://example.org/evenements/autre-rassemblement');
  });

  it('rejects a non-public route before producing any code', async () => {
    await expect(createEventQr({ slug: '../private?anonymousEventId=PRIVATE_ID' })).rejects.toThrow();
    await expect(createEventQr({ slug: 'public' }, 'file:///')).rejects.toThrow();
  });
});
