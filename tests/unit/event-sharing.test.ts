import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyEventLink, eventShareUrl, nativeShareAvailable, shareEvent } from '../../src/lib/client/event-sharing';

const target = { slug: 'rassemblement-choisi', name: 'Rassemblement public' };
const canonical = 'https://jemecompte.fr/evenements/rassemblement-choisi';

beforeEach(() => {
  vi.stubGlobal('location', {
    origin: 'https://jemecompte.fr', pathname: '/',
    search: '?anonymousEventId=PRIVATE_SENTINEL', hash: '#position=PRIVATE_SENTINEL',
    href: 'https://jemecompte.fr/?anonymousEventId=PRIVATE_SENTINEL#position=PRIVATE_SENTINEL'
  });
  vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('public event link', () => {
  it('uses the selected event slug on the homepage and never inherits query, hash or other event data', () => {
    const event = { ...target, anonymousEventId: 'PRIVATE_SENTINEL', id: 'another-id', cityName: 'Other data' };
    expect(eventShareUrl(event)).toBe(canonical);
    expect(new URL(eventShareUrl(event)).search).toBe('');
    expect(new URL(eventShareUrl(event)).hash).toBe('');
    expect(eventShareUrl(event)).not.toContain('PRIVATE_SENTINEL');
    expect(eventShareUrl(target, 'http://127.0.0.1:5173/other?private=value#private'))
      .toBe('http://127.0.0.1:5173/evenements/rassemblement-choisi');
  });

  it.each(['bad?private=value', '../other', 'bad#private', 'https://other.example', ''])('rejects an invalid slug %s', (slug) => {
    expect(() => eventShareUrl({ slug })).toThrow('Le lien du rassemblement n’est pas disponible.');
  });

  it('rejects non-web origins without attempting any native action', async () => {
    vi.stubGlobal('location', { origin: 'file://' });
    const native = vi.fn();
    const write = vi.fn();
    vi.stubGlobal('navigator', { share: native, clipboard: { writeText: write } });
    expect(await shareEvent(target)).toEqual({ status: 'error' });
    expect(await copyEventLink(target)).toEqual({ status: 'error' });
    expect(native).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('native sharing in the user gesture', () => {
  it('launches synchronously with only title and URL and preserves the native receiver', async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const browser = { share: vi.fn(function (this: unknown) { expect(this).toBe(browser); return pending; }) };
    vi.stubGlobal('navigator', browser);
    expect(nativeShareAvailable()).toBe(true);
    expect(browser.share).not.toHaveBeenCalled();
    const result = shareEvent({ ...target, anonymousEventId: 'PRIVATE_SENTINEL' } as typeof target);
    // No await/microtask has run before this assertion: activation is still available.
    expect(browser.share).toHaveBeenCalledExactlyOnceWith({ title: target.name, url: canonical });
    complete();
    expect(await result).toEqual({ status: 'shared', url: canonical });
  });

  it('treats a native cancellation as cancellation rather than an error', async () => {
    vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')) });
    expect(await shareEvent(target)).toEqual({ status: 'cancelled', url: canonical });
  });

  it('also recognizes synchronous cancellation and keeps other native errors private', async () => {
    vi.stubGlobal('navigator', { share: () => { throw new DOMException('Cancelled', 'AbortError'); } });
    expect(await shareEvent(target)).toEqual({ status: 'cancelled', url: canonical });
    vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(new Error('PRIVATE_ERROR_SENTINEL')) });
    expect(await shareEvent(target)).toEqual({ status: 'error', url: canonical });
  });

  it('provides a manual link when native sharing is unsupported, without making a request', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    expect(nativeShareAvailable()).toBe(false);
    expect(await shareEvent(target)).toEqual({ status: 'unavailable', url: canonical });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('copying an event link', () => {
  it('writes synchronously in the click gesture and preserves the clipboard receiver', async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const clipboard = { writeText: vi.fn(function (this: unknown) { expect(this).toBe(clipboard); return pending; }) };
    vi.stubGlobal('navigator', { clipboard });
    const result = copyEventLink(target);
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(canonical);
    complete();
    expect(await result).toEqual({ status: 'copied', url: canonical });
  });

  it('provides the manual URL when the clipboard is unsupported or rejects the request', async () => {
    const obsoleteCopy = vi.fn();
    vi.stubGlobal('document', { execCommand: obsoleteCopy });
    expect(await copyEventLink(target)).toEqual({ status: 'manual', url: canonical });
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')) } });
    expect(await copyEventLink(target)).toEqual({ status: 'manual', url: canonical });
    expect(obsoleteCopy).not.toHaveBeenCalled();
  });

  it('handles a clipboard security exception without hiding the manual URL', async () => {
    const browser = Object.defineProperty({}, 'clipboard', { get() { throw new DOMException('Denied', 'SecurityError'); } });
    vi.stubGlobal('navigator', browser);
    expect(await copyEventLink(target)).toEqual({ status: 'manual', url: canonical });
  });
});
