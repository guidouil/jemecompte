import { describe, expect, it } from 'vitest';
import { formatEventDateTime, parisDateTimeParts, parseParisDateTime } from '../../src/lib/shared/event-schedule';

describe('explicit Paris event schedule', () => {
  it.each([
    ['2026-01-20', '14:30', '2026-01-20T13:30:00.000Z'],
    ['2026-07-20', '14:30', '2026-07-20T12:30:00.000Z'],
    ['2026-10-17', '00:15', '2026-10-16T22:15:00.000Z'],
    ['2028-02-29', '23:59', '2028-02-29T22:59:00.000Z']
  ])('resolves %s %s and round-trips independently of the process timezone', (date, time, startsAt) => {
    expect(parseParisDateTime(date, time)).toEqual({ status: 'valid', startsAt });
    expect(parisDateTimeParts(Date.parse(startsAt))).toEqual({ date, time });
  });

  it.each([
    ['', ''], ['2026-02-29', '12:00'], ['2026-04-31', '12:00'], ['2026-00-20', '12:00'],
    ['2026-13-20', '12:00'], ['2026-01-00', '12:00'], ['0000-01-01', '12:00'],
    ['2026-01-20', '24:00'], ['2026-01-20', '12:60'], ['2026-01-20', '1:30'],
    ['2026-1-20', '12:00'], ['2026-01-20', '12:00:00'], ['2026-01-20T12:00Z', '12:00']
  ])('rejects invalid or incomplete calendar inputs %s %s', (date, time) => {
    expect(parseParisDateTime(date, time)).toEqual({ status: 'invalid' });
  });

  it('rejects the nonexistent hour on the spring DST change rather than shifting it', () => {
    expect(parseParisDateTime('2027-03-28', '02:30')).toEqual({ status: 'nonexistent' });
    expect(parseParisDateTime('2027-03-28', '01:30')).toEqual({ status: 'valid', startsAt: '2027-03-28T00:30:00.000Z' });
    expect(parseParisDateTime('2027-03-28', '03:30')).toEqual({ status: 'valid', startsAt: '2027-03-28T01:30:00.000Z' });
  });

  it('rejects the repeated hour on the autumn DST change instead of choosing silently', () => {
    expect(parseParisDateTime('2026-10-25', '02:30')).toEqual({ status: 'ambiguous' });
    expect(parseParisDateTime('2026-10-25', '01:30')).toEqual({ status: 'valid', startsAt: '2026-10-24T23:30:00.000Z' });
    expect(parseParisDateTime('2026-10-25', '03:30')).toEqual({ status: 'valid', startsAt: '2026-10-25T02:30:00.000Z' });
  });

  it('preserves four elapsed hours across both DST changes and the next calendar day', () => {
    for (const [date, time, end] of [
      ['2027-03-28', '00:30', { date: '2027-03-28', time: '05:30' }],
      ['2026-10-25', '00:30', { date: '2026-10-25', time: '03:30' }],
      ['2026-12-31', '23:00', { date: '2027-01-01', time: '03:00' }]
    ] as const) {
      const result = parseParisDateTime(date, time);
      if (result.status !== 'valid') throw new Error('Invalid schedule fixture.');
      expect(parisDateTimeParts(Date.parse(result.startsAt) + 4 * 3_600_000)).toEqual(end);
    }
  });

  it('displays the full date and Paris time rather than the device time', () => {
    const display = formatEventDateTime('2026-10-17T12:30:00.000Z');
    expect(display).toContain('17 octobre 2026');
    expect(display).toContain('14:30');
  });
});
