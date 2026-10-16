import type { PublicEvent } from '../shared/types';
import { eventShareUrl } from './event-sharing';

export interface EventQrCode { url: string; imageUrl: string }

/** Loaded only on request. The encoder receives the public route, with no local identity or position. */
export async function createEventQr(event: Pick<PublicEvent, 'slug'>, origin = globalThis.location?.origin): Promise<EventQrCode> {
  const url = eventShareUrl(event, origin);
  const { default: qrcode } = await import('qrcode-generator');
  const code = qrcode(0, 'M');
  code.addData(url, 'Byte');
  code.make();
  // Keep the standard four-module quiet zone on an opaque white background, including on paper.
  const svg = code.createSvgTag({ cellSize: 6, margin: 24, scalable: true });
  return { url, imageUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

/** Print a local document in the browser's own dialog, without opening a popup or contacting a service. */
export function printEventQr(name: string, code: EventQrCode, onClose?: () => void,
  scope: PublicEvent['countingScope'] = 'gathering', countingWindow?: Pick<PublicEvent, 'startsAt' | 'endsAt'>): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    const isCity = scope === 'city';
    frame.title = isCity ? 'Affiche du comptage de commune à imprimer' : 'Affiche du rassemblement à imprimer';
    frame.setAttribute('aria-hidden', 'true');
    frame.className = 'event-qr-print-frame';
    let timeout: ReturnType<typeof setTimeout>;
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      clearTimeout(timeout);
      frame.remove();
      onClose?.();
    };
    const fail = () => { remove(); reject(new Error('L’impression n’a pas pu s’ouvrir.')); };
    frame.onload = () => {
      const sheet = frame.contentDocument;
      const browser = frame.contentWindow;
      if (!sheet || !browser) { fail(); return; }
      const heading = sheet.createElement('h1');
      heading.textContent = name;
      const introduction = sheet.createElement('p');
      introduction.textContent = isCity ? 'Je me compte · Comptage dans toute la commune' : 'Je me compte · Scannez pour ouvrir ce rassemblement';
      const image = sheet.createElement('img');
      image.alt = isCity ? 'QR code du comptage public de commune' : 'QR code du lien public du rassemblement';
      const link = sheet.createElement('p');
      link.className = 'link';
      link.textContent = code.url;
      const instruction = sheet.createElement('p');
      instruction.textContent = isCity
        ? 'Dans la commune, ouvrez le lien et choisissez « Me compter dans cette ville ». Aucun compte nécessaire. Ce comptage ne confirme aucun lieu ni horaire de manifestation et ne prouve pas une participation à une manifestation.'
        : 'Sur place, ouvrez le lien et choisissez « Je me compte ». Aucun compte nécessaire.';
      sheet.body.append(heading, introduction, image, link, instruction);
      if (isCity && countingWindow && [countingWindow.startsAt, countingWindow.endsAt].every((value) => Number.isFinite(Date.parse(value)))) {
        const format = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris',
          day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const schedule = sheet.createElement('p');
        schedule.textContent = `Fenêtre de comptage : du ${format.format(new Date(countingWindow.startsAt))} au ${format.format(new Date(countingWindow.endsAt))}, heure de Paris.`;
        sheet.body.append(schedule);
      }
      image.onerror = fail;
      image.onload = () => {
        clearTimeout(timeout);
        browser.addEventListener('afterprint', remove, { once: true });
        timeout = setTimeout(remove, 60_000);
        try { browser.focus(); browser.print(); resolve(); }
        catch { fail(); }
      };
      image.src = code.imageUrl;
    };
    // Static markup only: event names and URLs are inserted with textContent above.
    frame.srcdoc = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Je me compte · Affiche</title><link rel="stylesheet" href="/print-event.css"></head><body></body></html>';
    timeout = setTimeout(fail, 10_000);
    document.body.append(frame);
  });
}
