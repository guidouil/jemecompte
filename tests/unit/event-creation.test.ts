import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEventPayloadSchema, isSupportedPublicCenter } from '../../src/lib/shared/event-creation';
import { CreationLimiter } from '../../src/lib/server/event-creation-abuse';
import { DEFAULT_EVENT_DURATION_MINUTES, EVENT_TIME_ZONE } from '../../src/lib/shared/event-limits';

const valid = () => ({
  requestId: randomUUID(), name: 'Rassemblement déclaré', cityName: 'Paris', cityCode: '75056',
  publicCenter: [2.36325, 48.86735], radiusMeters: 200, durationMinutes: 120, publicLocationConfirmed: true
});
const validCity = () => ({
  requestId: randomUUID(), name: 'Comptage de Paris', cityName: 'Paris', cityCode: '75056',
  countingScope: 'city' as const, durationMinutes: 240, publicLocationConfirmed: true
});

describe('public event creation contract', () => {
  it('accepts a whole commune by code without a browser-supplied perimeter', () => {
    const payload = validCity();
    expect(createEventPayloadSchema.parse(payload)).toEqual(payload);
    expect(createEventPayloadSchema.parse({ ...payload, cityName: ' Paris ', startsAt: '2030-07-15T15:30:00+02:00' }))
      .toEqual({ ...payload, startsAt: '2030-07-15T13:30:00.000Z' });
  });

  it('rejects client geometry and coordinates on a whole-commune request', () => {
    const payload = validCity();
    for (const extra of [
      { publicCenter: [2.36, 48.86] }, { radiusMeters: 500 },
      { geofence: { type: 'Polygon', coordinates: [[[2, 48], [3, 48], [3, 49], [2, 48]]] } },
      { center: [2.36, 48.86] }, { contour: {} }, { latitude: 48.86 }, { anonymousEventId: 'private' }
    ]) expect(createEventPayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(false);
    expect(createEventPayloadSchema.safeParse({ ...valid(), countingScope: 'city' }).success).toBe(false);
  });

  it('requires the commune scope, explicit city selection and publication confirmation', () => {
    const payload = validCity();
    for (const replacement of [
      { countingScope: undefined }, { countingScope: 'gathering' }, { countingScope: 'country' },
      { cityCode: undefined }, { cityCode: 'Paris' }, { cityName: undefined },
      { durationMinutes: undefined }, { publicLocationConfirmed: false }, { publicLocationConfirmed: undefined }
    ]) expect(createEventPayloadSchema.safeParse({ ...payload, ...replacement }).success).toBe(false);
    expect(createEventPayloadSchema.safeParse({ ...payload, cityCode: '2A004' }).success).toBe(true);
  });

  it('keeps the explicit gathering scope compatible with the existing radius contract', () => {
    expect(createEventPayloadSchema.safeParse({ ...valid(), countingScope: 'gathering' }).success).toBe(true);
    expect(createEventPayloadSchema.safeParse({ ...valid(), countingScope: 'country' }).success).toBe(false);
  });

  it('normalizes only explicit public fields and requires publication confirmation', () => {
    const payload = valid();
    expect(createEventPayloadSchema.parse({ ...payload, name: '  Rassemblement déclaré  ', cityName: ' Paris ' }))
      .toEqual(payload);
    expect(createEventPayloadSchema.safeParse({ ...payload, publicLocationConfirmed: false }).success).toBe(false);
    expect(createEventPayloadSchema.safeParse({ ...payload, publicLocationConfirmed: undefined }).success).toBe(false);
    expect(createEventPayloadSchema.safeParse({ ...payload, anonymousEventId: 'private' }).success).toBe(false);
    expect(createEventPayloadSchema.safeParse({ ...payload, latitude: 48.8 }).success).toBe(false);
  });

  it('defines a four-hour display default without accepting an omitted duration in the API', () => {
    expect(DEFAULT_EVENT_DURATION_MINUTES).toBe(240);
    expect(EVENT_TIME_ZONE).toBe('Europe/Paris');
    expect(createEventPayloadSchema.safeParse({ ...valid(), durationMinutes: undefined }).success).toBe(false);
  });

  it.each([
    ['2030-01-15T15:30:00+01:00', '2030-01-15T14:30:00.000Z'],
    ['2030-07-15T15:30:00+02:00', '2030-07-15T13:30:00.000Z'],
    ['2030-07-15T13:30:00Z', '2030-07-15T13:30:00.000Z'],
    ['2030-07-15T09:00:00.123-04:30', '2030-07-15T13:30:00.123Z'],
    ['2030-03-31T01:30:00+01:00', '2030-03-31T00:30:00.000Z'],
    ['2030-10-27T02:30:00+02:00', '2030-10-27T00:30:00.000Z'],
    ['2030-10-27T02:30:00+01:00', '2030-10-27T01:30:00.000Z'],
    ['2100-01-01T00:00:00Z', '2100-01-01T00:00:00.000Z']
  ])('normalizes the explicitly zoned instant %s to UTC without a future horizon', (startsAt, expected) => {
    expect(createEventPayloadSchema.parse({ ...valid(), startsAt }).startsAt).toBe(expected);
  });

  it('keeps an absent start absent, and leaves temporal admission to the server clock', () => {
    expect(createEventPayloadSchema.parse(valid())).not.toHaveProperty('startsAt');
    expect(createEventPayloadSchema.parse({ ...valid(), startsAt: '2000-01-01T00:00:00Z' }).startsAt)
      .toBe('2000-01-01T00:00:00.000Z');
  });

  it.each([
    '2030-01-15', '2030-01-15T15:30:00', '2030-01-15T15:30:00 Europe/Paris',
    '2030-01-15T15:30:00+25:00', '2030-02-30T15:30:00Z', 'not-a-date',
    '2030-01-15T15:30:00+0100', '', 0, null, new Date('2030-01-15T15:30:00Z')
  ])('rejects a non-ISO, ambiguous or non-string start %s without coercion', (startsAt) => {
    expect(createEventPayloadSchema.safeParse({ ...valid(), startsAt }).success).toBe(false);
  });

  it('rejects controls, HTML, invalid lengths, codes, radii, durations and non-finite locations', () => {
    for (const replacement of [
      { name: 'ab' }, { name: 'x'.repeat(121) }, { name: 'Marche\nParis' }, { name: '\tMarche' },
      { name: 'Marche\u202E' }, { name: '<script>alert(1)</script>' }, { cityName: 'P' },
      { cityCode: 'paris' }, { radiusMeters: 99 }, { radiusMeters: 10_001 }, { durationMinutes: 4321 },
      { publicCenter: [Number.NaN, 48] }, { publicCenter: [2, Infinity] }, { publicCenter: [2, 48, 1] }
    ]) expect(createEventPayloadSchema.safeParse({ ...valid(), ...replacement }).success).toBe(false);
    expect(createEventPayloadSchema.safeParse({ ...valid(), cityCode: '2A004' }).success).toBe(true);
  });

  it.each([100, 101, 150, 200, 500, 750, 1234, 9999, 10_000])('accepts an explicitly supplied integer radius of %d meters', (radiusMeters) => {
    const payload = createEventPayloadSchema.parse({ ...valid(), radiusMeters });
    expect('radiusMeters' in payload && payload.radiusMeters).toBe(radiusMeters);
  });

  it.each([0, 99, -200, 10_001, 1234.5, 500.1, NaN, Infinity, -Infinity, '500', null, undefined])(
    'rejects out-of-range, fractional or non-numeric radius %s without coercion', (radiusMeters) => {
      expect(createEventPayloadSchema.safeParse({ ...valid(), radiusMeters }).success).toBe(false);
    }
  );

  it.each([60, 120, 240, 480, 720, 1440, 2880, 4320])('accepts the listed duration of %d minutes', (durationMinutes) => {
    expect(createEventPayloadSchema.parse({ ...valid(), durationMinutes }).durationMinutes).toBe(durationMinutes);
  });

  it.each([0, -60, 90, 719, 1000, 4321, 10_080, 720.5, NaN, Infinity, '1440', null, undefined])(
    'rejects unlisted, fractional or non-numeric duration %s without coercion', (durationMinutes) => {
      expect(createEventPayloadSchema.safeParse({ ...valid(), durationMinutes }).success).toBe(false);
    }
  );

  it('supports the named metropolitan and DROM discovery regions without claiming exact borders', () => {
    const centers: [number, number][] = [
      [2.35,48.85], [9.45,42.7], [-61.53,16.24], [-61.05,14.61], [-52.33,4.94], [55.45,-20.88], [45.22,-12.78]
    ];
    for (const center of centers) expect(isSupportedPublicCenter(center)).toBe(true);
    expect(isSupportedPublicCenter([13.4,52.5])).toBe(false);
    expect(isSupportedPublicCenter([-149.56,-17.55])).toBe(false);
    // Broad bounding boxes include neighbouring areas; they do not authenticate country or city.
    expect(isSupportedPublicCenter([4.35,50.85])).toBe(true);
  });
});

describe('separate creation limits', () => {
  it('limits ten creation attempts per network window without consuming global quota on denied repeats', () => {
    const limiter = new CreationLimiter();
    for (let i = 0; i < 10; i++) expect(limiter.allow('shared-network', 1_000).allowed).toBe(true);
    for (let i = 0; i < 100; i++) expect(limiter.allow('shared-network', 1_000).allowed).toBe(false);
    for (let peer = 0; peer < 9; peer++) {
      for (let i = 0; i < 10; i++) expect(limiter.allow(`other-${peer}`, 1_000).allowed).toBe(true);
    }
    expect(limiter.allow('last-peer', 1_000)).toEqual({ allowed: false, retryAfter: 3600 });
    expect(limiter.allow('last-peer', 3_601_000).allowed).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it('keeps memory bounded, independently of participant identifiers or events', () => {
    const limiter = new CreationLimiter(2);
    expect(limiter.allow('network-a', 100).allowed).toBe(true);
    expect(limiter.allow('network-b', 100).allowed).toBe(true);
    expect(limiter.allow('network-c', 100).allowed).toBe(false);
    expect(limiter.size).toBe(2);
  });
});
