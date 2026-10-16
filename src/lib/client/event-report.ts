import type { PublicEvent } from '../shared/types';
import { eventShareUrl } from './event-sharing';

/** Prepare a message only; the user's mail client remains responsible for composing and sending it. */
export function eventReportMailto(event: Pick<PublicEvent, 'slug' | 'name' | 'cityName'>, origin = globalThis.location?.origin): string {
  const url = eventShareUrl(event, origin);
  const subject = `JeMeCompte · ${event.name} · ${event.cityName}`.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const body = `${url}\n\nErreur sur le lieu ou les horaires :\n[À compléter]\n`;
  return `mailto:guidouil@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
