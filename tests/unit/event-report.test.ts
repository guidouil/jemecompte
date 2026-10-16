import { afterEach, expect, it, vi } from 'vitest';
import { eventReportMailto } from '../../src/lib/client/event-report';

afterEach(() => vi.unstubAllGlobals());

it('prepares only the public event link and correction text for the public contact, without sending anything', () => {
  vi.stubGlobal('location', {
    origin: 'https://jemecompte.fr',
    href: 'https://jemecompte.fr/?anonymousEventId=PRIVATE_ID#position=PRIVATE_POSITION'
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const target = { slug: 'rassemblement-public', name: 'Nom & amis ? #', cityName: 'Paris', anonymousEventId: 'PRIVATE_ID' };
  const mail = new URL(eventReportMailto(target));
  expect(mail.protocol).toBe('mailto:');
  expect(mail.pathname).toBe('guidouil@gmail.com');
  expect([...mail.searchParams.keys()]).toEqual(['subject', 'body']);
  expect(mail.searchParams.get('subject')).toBe('JeMeCompte · Nom & amis ? # · Paris');
  expect(mail.searchParams.get('body')).toBe('https://jemecompte.fr/evenements/rassemblement-public\n\nErreur sur le lieu ou les horaires :\n[À compléter]\n');
  expect(mail.href).not.toContain('PRIVATE_');
  expect(fetch).not.toHaveBeenCalled();
});

it('removes header control characters and rejects a non-public route', () => {
  const origin = 'https://jemecompte.fr';
  const mail = new URL(eventReportMailto({ slug: 'public', name: 'Nom\r\nbcc:someone@example.org', cityName: 'Paris\u0000' }, origin));
  expect(mail.searchParams.get('subject')).not.toMatch(/[\r\n\u0000]/);
  expect([...mail.searchParams.keys()]).toEqual(['subject', 'body']);
  expect(() => eventReportMailto({ slug: '../private', name: 'Nom', cityName: 'Paris' }, origin)).toThrow();
});
