import type { CreateEventPayload } from '../shared/event-creation';
import { EVENT_DURATIONS, MAX_EVENT_RADIUS_METERS, MIN_EVENT_RADIUS_METERS } from '../shared/event-limits';

export const EVENT_CREATION_DRAFT_KEY = 'jemecompte-public-creation-v1';
export const EVENT_CREATION_DRAFT_TTL_MS = 24 * 60 * 60_000;

export interface EventCreationDraft {
  version: 1;
  savedAt: number;
  payload: CreateEventPayload;
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type DraftLoadResult = { status: 'ready'; draft: EventCreationDraft }
  | { status: 'empty' | 'expired' | 'invalid' | 'unavailable' };
export type DraftSaveResult = { status: 'saved' | 'unavailable'; draft: EventCreationDraft }
  | { status: 'invalid' };

const payloadKeys = new Set(['requestId', 'name', 'cityCode', 'cityName', 'publicCenter',
  'radiusMeters', 'durationMinutes', 'startsAt', 'publicLocationConfirmed']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value === value.trim() && value.length >= minimum &&
    value.length <= maximum && !/[\p{Cc}\p{Cf}<>]/u.test(value);
}

/** Only confirmed public configuration belongs here. Server validation remains authoritative. */
function publicPayload(value: unknown): CreateEventPayload | undefined {
  if (!record(value) || Object.keys(value).some((key) => !payloadKeys.has(key)) ||
    typeof value.requestId !== 'string' || !uuid.test(value.requestId) ||
    !text(value.name, 3, 120) || !text(value.cityName, 2, 100) ||
    typeof value.cityCode !== 'string' || !/^[0-9AB]{5}$/.test(value.cityCode) ||
    !Array.isArray(value.publicCenter) || value.publicCenter.length !== 2 ||
    !value.publicCenter.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) ||
    Math.abs(value.publicCenter[0]) > 180 || Math.abs(value.publicCenter[1]) > 90 ||
    typeof value.radiusMeters !== 'number' || !Number.isInteger(value.radiusMeters) ||
    value.radiusMeters < MIN_EVENT_RADIUS_METERS || value.radiusMeters > MAX_EVENT_RADIUS_METERS ||
    !EVENT_DURATIONS.some((duration) => duration === value.durationMinutes) ||
    value.publicLocationConfirmed !== true) return;
  if (value.startsAt !== undefined && (typeof value.startsAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startsAt)) || new Date(value.startsAt).toISOString() !== value.startsAt)) return;
  // Construct a fresh allowlisted object; never serialize arbitrary caller properties.
  return {
    requestId: value.requestId, name: value.name, cityCode: value.cityCode, cityName: value.cityName,
    publicCenter: [value.publicCenter[0], value.publicCenter[1]], radiusMeters: value.radiusMeters,
    durationMinutes: value.durationMinutes as CreateEventPayload['durationMinutes'],
    ...(value.startsAt !== undefined ? { startsAt: value.startsAt as string } : {}),
    publicLocationConfirmed: true
  };
}

function storage(provided?: DraftStorage): DraftStorage {
  return provided ?? globalThis.sessionStorage;
}

export function saveEventCreationDraft(payload: unknown, now = Date.now(), provided?: DraftStorage): DraftSaveResult {
  const clean = publicPayload(payload);
  if (!clean || !Number.isSafeInteger(now) || now < 0) return { status: 'invalid' };
  const draft: EventCreationDraft = { version: 1, savedAt: now, payload: clean };
  try {
    storage(provided).setItem(EVENT_CREATION_DRAFT_KEY, JSON.stringify(draft));
    return { status: 'saved', draft };
  } catch {
    return { status: 'unavailable', draft };
  }
}

export function loadEventCreationDraft(now = Date.now(), provided?: DraftStorage): DraftLoadResult {
  try {
    const target = storage(provided);
    const raw = target.getItem(EVENT_CREATION_DRAFT_KEY);
    if (raw === null) return { status: 'empty' };
    let value: unknown;
    try { value = raw.length <= 8_192 ? JSON.parse(raw) : null; } catch { value = null; }
    if (!record(value) || Object.keys(value).some((key) => !['version', 'savedAt', 'payload'].includes(key)) ||
      value.version !== 1 || typeof value.savedAt !== 'number' || !Number.isSafeInteger(value.savedAt) ||
      value.savedAt < 0 || value.savedAt > now) {
      target.removeItem(EVENT_CREATION_DRAFT_KEY);
      return { status: 'invalid' };
    }
    if (now - value.savedAt >= EVENT_CREATION_DRAFT_TTL_MS) {
      target.removeItem(EVENT_CREATION_DRAFT_KEY);
      return { status: 'expired' };
    }
    const payload = publicPayload(value.payload);
    if (!payload) {
      target.removeItem(EVENT_CREATION_DRAFT_KEY);
      return { status: 'invalid' };
    }
    return { status: 'ready', draft: { version: 1, savedAt: value.savedAt, payload } };
  } catch {
    return { status: 'unavailable' };
  }
}

export function clearEventCreationDraft(provided?: DraftStorage): boolean {
  try {
    storage(provided).removeItem(EVENT_CREATION_DRAFT_KEY);
    return true;
  } catch {
    return false;
  }
}
