import type { PublicEvent } from '../shared/types';

type ShareTarget = Pick<PublicEvent, 'slug' | 'name'>;
export interface CopyEventResult { status: 'copied' | 'manual' | 'error'; url?: string }
export interface ShareEventResult { status: 'shared' | 'cancelled' | 'unavailable' | 'error'; url?: string }

/** Build only the public event route; never inherit the current page's path, search or hash. */
export function eventShareUrl(event: Pick<PublicEvent, 'slug'>, origin = globalThis.location?.origin): string {
  if (!origin || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.slug) || event.slug.length > 100) {
    throw new Error('Le lien du rassemblement n’est pas disponible.');
  }
  const base = new URL(origin);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('Le lien du rassemblement n’est pas disponible.');
  }
  return new URL(`/evenements/${event.slug}`, base.origin).href;
}

export function nativeShareAvailable(): boolean {
  try { return typeof globalThis.navigator?.share === 'function'; }
  catch { return false; }
}

function isCancellation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** Invoke from a click handler: the native call occurs synchronously, before any promise is awaited. */
export function shareEvent(event: ShareTarget): Promise<ShareEventResult> {
  let url: string;
  try { url = eventShareUrl(event); }
  catch { return Promise.resolve({ status: 'error' }); }
  try {
    const browser = globalThis.navigator;
    if (typeof browser?.share !== 'function') return Promise.resolve({ status: 'unavailable', url });
    const operation = browser.share({ title: event.name, url });
    return Promise.resolve(operation).then(
      (): ShareEventResult => ({ status: 'shared', url }),
      (error: unknown): ShareEventResult => ({ status: isCancellation(error) ? 'cancelled' : 'error', url })
    );
  } catch (error) {
    return Promise.resolve({ status: isCancellation(error) ? 'cancelled' : 'error', url });
  }
}

/** Copy only on explicit action; a failed or absent clipboard API leaves manual copying to the UI. */
export function copyEventLink(event: Pick<PublicEvent, 'slug'>): Promise<CopyEventResult> {
  let url: string;
  try { url = eventShareUrl(event); }
  catch { return Promise.resolve({ status: 'error' }); }
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') return Promise.resolve({ status: 'manual', url });
    const operation = clipboard.writeText(url);
    return Promise.resolve(operation).then(
      (): CopyEventResult => ({ status: 'copied', url }),
      (): CopyEventResult => ({ status: 'manual', url })
    );
  } catch { return Promise.resolve({ status: 'manual', url }); }
}
