import { isSupportedPublicCenter } from '../shared/event-creation';
import { MAX_CITY_GEOFENCE_BYTES, validateGeofence } from '../shared/geofence';
import type { EventGeofence } from '../shared/types';

/** Public cartography only. Never forward client headers, cookies or IP to providers. */
export interface PublicPlace { code: string; name: string; center: [number, number] }
export interface PublicPlaceBoundary extends PublicPlace { geofence: EventGeofence }
interface Cached<T> { value: T; expiresAt: number }
const places = new Map<string, Cached<PublicPlace[]>>();
const boundaries = new Map<string, Cached<PublicPlaceBoundary>>();
const tiles = new Map<string, Cached<Uint8Array>>();
const pending = new Map<string, Promise<unknown>>();
let tileBytes = 0;
let active = 0;
let windowStart = 0;
let requests = 0;

export class MapUnavailable extends Error {}

async function external<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const now = Date.now();
  if (now - windowStart >= 1_000) { windowStart = now; requests = 0; }
  if (active >= 16 || requests >= 30) throw new MapUnavailable();
  active++; requests++;
  const result = work();
  pending.set(key, result);
  try { return await result; }
  finally { active--; pending.delete(key); }
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get('content-length')) > limit || !response.body) throw new MapUnavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new MapUnavailable();
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function normalizePlaceQuery(value: string): string | null {
  const query = value.trim().normalize('NFC').replace(/\s+/g, ' ');
  return query.length >= 2 && query.length <= 80 && /^[\p{L}\p{M}\d '\u2019-]+$/u.test(query) ? query : null;
}

export async function searchPublicPlaces(query: string): Promise<PublicPlace[]> {
  const key = query.toLocaleLowerCase('fr');
  const cached = places.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return external(`place:${key}`, async () => {
    const url = new URL('https://geo.api.gouv.fr/communes');
    url.search = new URLSearchParams({ nom: query, fields: 'nom,code,centre', boost: 'population', limit: '6' }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000), redirect: 'error', headers: { accept: 'application/json' } });
    const bytes = await readBounded(response, 24_000);
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(data)) throw new MapUnavailable();
    const result: PublicPlace[] = [];
    for (const item of data.slice(0, 6)) {
      if (!item || typeof item !== 'object') continue;
      const point: unknown = item.centre?.coordinates;
      if (typeof item.nom !== 'string' || item.nom.length > 120 || typeof item.code !== 'string' || !/^[0-9AB]{5}$/.test(item.code) ||
          !Array.isArray(point) || point.length !== 2 || !point.every((part) => typeof part === 'number' && Number.isFinite(part)) ||
          Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85) continue;
      result.push({ code: item.code, name: item.nom, center: [point[0], point[1]] });
    }
    if (places.size >= 128) places.delete(places.keys().next().value!);
    places.set(key, { value: result, expiresAt: Date.now() + 3_600_000 });
    return result;
  });
}

/** A commune code selects a fixed official resource; client geometry is never accepted. */
export async function getPublicPlaceBoundary(code: string): Promise<PublicPlaceBoundary> {
  if (!/^[0-9AB]{5}$/.test(code)) throw new MapUnavailable();
  const cached = boundaries.get(code);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return external(`boundary:${code}`, async () => {
    try {
      const url = new URL(`https://geo.api.gouv.fr/communes/${code}`);
      url.search = new URLSearchParams({ fields: 'nom,code,centre,contour' }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(6_000), redirect: 'error', headers: { accept: 'application/json' } });
      // Geometry has its own 250 KiB budget; allow only a little extra for public metadata.
      const bytes = await readBounded(response, MAX_CITY_GEOFENCE_BYTES + 2_048);
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MapUnavailable();
      const item = data as Record<string, unknown>;
      const centre = item.centre as { type?: unknown; coordinates?: unknown } | null | undefined;
      const point = centre?.coordinates;
      if (item.code !== code || typeof item.nom !== 'string' || item.nom.trim().length < 2 || item.nom.length > 100 ||
          /[\p{Cc}\p{Cf}<>]/u.test(item.nom) || centre?.type !== 'Point' || !Array.isArray(point) || point.length !== 2 ||
          !point.every((part) => typeof part === 'number' && Number.isFinite(part)) ||
          !isSupportedPublicCenter(point as [number, number])) throw new MapUnavailable();
      const geofence = validateGeofence(item.contour, 'city');
      const result: PublicPlaceBoundary = { code, name: item.nom.trim(), center: [point[0], point[1]], geofence };
      // At most 8 MiB of validated contours, independently of tile/search caches.
      if (boundaries.size >= 32) boundaries.delete(boundaries.keys().next().value!);
      boundaries.set(code, { value: result, expiresAt: Date.now() + 24 * 3_600_000 });
      return result;
    } catch {
      throw new MapUnavailable();
    }
  });
}

export function parseTile(z: string, x: string, y: string): [number, number, number] | null {
  if (![z, x, y].every((value) => /^(0|[1-9]\d{0,6})$/.test(value))) return null;
  const zoom = Number(z), column = Number(x), row = Number(y);
  if (zoom < 5 || zoom > 19 || column >= 2 ** zoom || row >= 2 ** zoom) return null;
  return [zoom, column, row];
}

export async function getPublicTile(tile: [number, number, number]): Promise<Uint8Array> {
  const key = tile.join('/');
  const cached = tiles.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return external(`tile:${key}`, async () => {
    const [z, x, y] = tile;
    const url = new URL('https://data.geopf.fr/wmts');
    url.search = new URLSearchParams({ SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetTile',
      LAYER: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', STYLE: 'normal', FORMAT: 'image/png', TILEMATRIXSET: 'PM',
      TILEMATRIX: String(z), TILECOL: String(x), TILEROW: String(y) }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000), redirect: 'error', headers: { accept: 'image/png' } });
    if (!response.headers.get('content-type')?.startsWith('image/png')) throw new MapUnavailable();
    const bytes = await readBounded(response, 256_000);
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new MapUnavailable();
    const previous = tiles.get(key);
    if (previous) { tileBytes -= previous.value.byteLength; tiles.delete(key); }
    while (tiles.size >= 256 || tileBytes + bytes.byteLength > 16 * 1024 * 1024) {
      const oldest = tiles.keys().next().value;
      if (!oldest) break;
      tileBytes -= tiles.get(oldest)!.value.byteLength;
      tiles.delete(oldest);
    }
    tiles.set(key, { value: bytes, expiresAt: Date.now() + 24 * 3_600_000 });
    tileBytes += bytes.byteLength;
    return bytes;
  });
}
