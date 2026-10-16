/** Shared product limits; safe to import from UI without loading request-validation dependencies. */
export const MIN_EVENT_RADIUS_METERS = 100;
export const MAX_EVENT_RADIUS_METERS = 10_000;
export const DEFAULT_EVENT_RADIUS_METERS = 500;
export const EVENT_DURATIONS = [60, 120, 240, 480, 720, 1440, 2880, 4320] as const;
export const DEFAULT_EVENT_DURATION_MINUTES = 240;
export const EVENT_TIME_ZONE = 'Europe/Paris';
