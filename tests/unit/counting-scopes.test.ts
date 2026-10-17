import { describe, expect, it } from 'vitest';
import { createEventPayloadSchema } from '../../src/lib/shared/event-creation';
import { parseCounterSnapshot } from '../../src/lib/client/counter-snapshot';

describe('counting scope boundary', () => {
  it('accepts a whole commune only by its code and never with a creator-supplied perimeter', () => {
    const request = {
      requestId: '5a52252e-28ae-49f6-ab20-98805d61d094', name: 'Lieu public fictif', cityCode: '75056', cityName: 'Paris',
      publicCenter: [2.36,48.86], radiusMeters: 500, durationMinutes: 720, publicLocationConfirmed: true
    };
    expect(createEventPayloadSchema.safeParse(request).success).toBe(true);
    expect(createEventPayloadSchema.safeParse({ ...request, countingScope: 'city' }).success).toBe(false);
    expect(createEventPayloadSchema.safeParse({ ...request, geofence: { type: 'MultiPolygon', coordinates: [] } }).success).toBe(false);
    const { publicCenter: _center, radiusMeters: _radius, ...city } = request;
    expect(createEventPayloadSchema.safeParse({ ...city, countingScope: 'city' }).success).toBe(true);
    expect(createEventPayloadSchema.safeParse({ ...city, countingScope: 'city', geofence: { type: 'MultiPolygon', coordinates: [] } }).success).toBe(false);
  });

  it('rejects an unknown counter scope before displaying a server response', () => {
    const snapshot = {
      eventId: 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a', total: '1', revision: '1', day: '2026-10-17',
      nationalTotal: '1', nationalRevision: '1', cityTotal: '1', cityRevision: '1', epoch: '1',
      serverTime: '2026-10-17T08:00:00Z', eventStatus: 'published', integrityStatus: 'normal', metadataVersion: 1,
      startsAt: '2026-10-17T05:00:00Z', endsAt: '2026-10-17T17:00:00Z'
    };
    expect(parseCounterSnapshot(snapshot)).toBeDefined();
    expect(parseCounterSnapshot({ ...snapshot, countingScope: 'city' })).toBeDefined();
    expect(parseCounterSnapshot({ ...snapshot, countingScope: 'gathering' })).toBeDefined();
    expect(parseCounterSnapshot({ ...snapshot, countingScope: 'country' })).toBeUndefined();
  });
});
