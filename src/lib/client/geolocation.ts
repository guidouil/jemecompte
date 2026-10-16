import { isInsideGeofence } from '../shared/geofence';
import type { PublicEvent } from '../shared/types';

export type LocationErrorCode =
  | 'permission_denied'
  | 'position_unavailable'
  | 'location_timeout'
  | 'location_unsupported'
  | 'inaccurate_position';

export class LocationError extends Error {
  constructor(public readonly code: LocationErrorCode, message: string) {
    super(message);
    this.name = 'LocationError';
  }
}

export function isEventOpen(event: PublicEvent, now = Date.now()): boolean {
  return (
    event.status === 'published' &&
    event.integrityStatus !== 'suspended' &&
    !event.finalizedAt &&
    !event.presencesPurgedAt &&
    now >= Date.parse(event.startsAt) &&
    now < Date.parse(event.endsAt)
  );
}

/** The only outward result is a matching public event list. Never expose or persist coordinates. */
export async function locateEvents(
  events: PublicEvent[],
  selectedEventId?: string
): Promise<{ events: PublicEvent[]; capturedAt: number }> {
  if (
    !globalThis.navigator?.geolocation ||
    (typeof globalThis.isSecureContext === 'boolean' && !globalThis.isSecureContext)
  ) {
    throw new LocationError(
      'location_unsupported',
      'La localisation n’est pas disponible. Ouvrez ce site en HTTPS dans votre navigateur.'
    );
  }
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      (error) => {
        if (error.code === 1) {
          reject(
            new LocationError(
              'permission_denied',
              'La localisation a été refusée. Vous pouvez la réautoriser dans les réglages du site.'
            )
          );
        } else if (error.code === 3) {
          reject(new LocationError('location_timeout', 'La localisation prend trop de temps. Réessayez.'));
        } else {
          reject(
            new LocationError('position_unavailable', 'Votre position est indisponible. Réessayez dehors.')
          );
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 }
    );
  });
  const { longitude, latitude, accuracy } = position.coords;
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(accuracy) ||
    accuracy < 0 ||
    accuracy > 100
  ) {
    throw new LocationError(
      'inaccurate_position',
      'Votre position n’est pas assez précise. Attendez un instant puis réessayez.'
    );
  }
  const capturedAt = Date.now();
  return {
    events: events.filter(
      (event) =>
        (!selectedEventId || event.id === selectedEventId) &&
        isEventOpen(event, capturedAt) &&
        isInsideGeofence(longitude, latitude, event.geofence)
    ),
    capturedAt
  };
}
