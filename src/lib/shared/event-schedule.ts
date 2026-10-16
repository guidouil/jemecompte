import { EVENT_TIME_ZONE } from './event-limits';

export type ParisDateTimeResult =
  | { status: 'valid'; startsAt: string }
  | { status: 'invalid' | 'nonexistent' | 'ambiguous' };

const clock = new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn', {
  timeZone: EVENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const display = new Intl.DateTimeFormat('fr-FR', {
  timeZone: EVENT_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function numericParts(instant: number): Record<string, number> {
  return Object.fromEntries(clock.formatToParts(instant)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function utcTime(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  // Date.UTC treats years 0..99 as 1900..1999; setUTCFullYear preserves the entered year.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** Form values in the explicit product timezone, independent of the device timezone. */
export function parisDateTimeParts(instant: number): { date: string; time: string } {
  const parts = numericParts(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${String(parts.year!).padStart(4, '0')}-${pad(parts.month!)}-${pad(parts.day!)}`,
    time: `${pad(parts.hour!)}:${pad(parts.minute!)}`
  };
}

/** Resolve a Paris wall time. Gaps and repeated hours require another explicit choice. */
export function parseParisDateTime(date: string, time: string): ParisDateTimeResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { status: 'invalid' };
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { status: 'invalid' };
  }
  const wallTime = utcTime(year, month, day, hour, minute);
  const wall = new Date(wallTime);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() + 1 !== month || wall.getUTCDate() !== day) {
    return { status: 'invalid' };
  }
  // Inspect offsets on either side of the date, so DST gaps/folds cannot silently shift the input.
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 12, 36]) {
    const sample = wallTime + hours * 3_600_000;
    const parts = numericParts(sample);
    offsets.add(utcTime(parts.year!, parts.month!, parts.day!, parts.hour!, parts.minute!, parts.second!) - sample);
  }
  const candidates = [...offsets].map((offset) => wallTime - offset).filter((instant) => {
    const parts = parisDateTimeParts(instant);
    return parts.date === date && parts.time === time;
  });
  if (candidates.length === 0) return { status: 'nonexistent' };
  if (candidates.length > 1) return { status: 'ambiguous' };
  return { status: 'valid', startsAt: new Date(candidates[0]!).toISOString() };
}

/** Full date at minute precision; callers label the explicit timezone in their interface. */
export function formatEventDateTime(instant: string | number): string {
  return display.format(typeof instant === 'string' ? new Date(instant) : instant);
}
