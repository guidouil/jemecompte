import { describe, expect, it } from 'vitest';
import { DEFAULT_DESCRIPTION, pageMetadata, publicOrigin } from '../../src/lib/shared/seo';
import type { PublicEvent } from '../../src/lib/shared/types';

describe('public sharing metadata', () => {
  it('uses only a valid configured public origin and has a production fallback', () => {
    expect(publicOrigin()).toBe('https://jemecompte.fr');
    expect(publicOrigin('https://jemecompte.fr/')).toBe('https://jemecompte.fr');
    expect(publicOrigin('http://127.0.0.1:5175')).toBe('http://127.0.0.1:5175');
    for (const value of ['invalid', 'file:///tmp/private', 'https://user:private@example.com', 'https://example.com/private', 'https://example.com?private=1']) {
      expect(publicOrigin(value)).toBe('https://jemecompte.fr');
    }
  });

  it('keeps homepage metadata and gives each gathering its own canonical title and description', () => {
    const event = { name: 'Un rassemblement', slug: 'rassemblement', cityName: 'Lyon', description: 'Un geste collectif.', countingScope: 'gathering' } as PublicEvent;
    expect(pageMetadata('/', event)).toEqual({ title: 'JE ME COMPTE — On est là, on se compte', description: DEFAULT_DESCRIPTION, path: '/' });
    expect(pageMetadata('/evenements/rassemblement', event)).toEqual({
      title: 'Un rassemblement — JE ME COMPTE',
      description: 'Comptage volontaire à Lyon. Un geste collectif.', path: '/evenements/rassemblement'
    });
  });

  it('retains the whole-commune scope in its sharing description without inventing counts', () => {
    const event = { name: 'Comptage de Lyon', slug: 'lyon', cityName: 'Lyon', description: null, countingScope: 'city' } as PublicEvent;
    expect(pageMetadata('/evenements/lyon', event).description).toBe('Comptage volontaire dans toute la commune de Lyon. Déclarez votre participation sur place ou votre soutien à distance, sans inscription.');
  });
});
