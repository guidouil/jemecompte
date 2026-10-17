import type { PublicEvent } from './types';

export const DEFAULT_DESCRIPTION = 'Sur place ou à distance, votre geste compte. Déclarez votre participation à un rassemblement ou votre soutien, sans inscription. Découvrez la méthode et ses limites.';
export const SHARE_IMAGE_ALT = 'Une foule de petits personnages compose les mots JE ME COMPTE, avec la signature « On est là, on se compte ».';

export function publicOrigin(configured?: string): string {
  try {
    const url = new URL(configured || 'https://jemecompte.fr');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return 'https://jemecompte.fr';
    return url.origin;
  } catch { return 'https://jemecompte.fr'; }
}

export function pageMetadata(pathname: string, event?: PublicEvent | null) {
  if (pathname.startsWith('/evenements/') && event) {
    const scope = event.countingScope === 'city' ? `Comptage volontaire dans toute la commune de ${event.cityName}` : `Comptage volontaire à ${event.cityName}`;
    const description = `${scope}. ${event.description?.trim() || 'Déclarez votre participation sur place ou votre soutien à distance, sans inscription.'}`.slice(0, 300);
    return { title: `${event.name} — JE ME COMPTE`, description, path: `/evenements/${encodeURIComponent(event.slug)}` };
  }
  const titles: Record<string, string> = {
    '/': 'JE ME COMPTE — On est là, on se compte',
    '/creer': 'Ouvrir un comptage — JE ME COMPTE',
    '/comment-ca-marche': 'La méthode et ses limites — JE ME COMPTE',
    '/confidentialite': 'Confidentialité — JE ME COMPTE',
    '/transparence': 'Transparence du code — JE ME COMPTE'
  };
  return { title: titles[pathname] ?? 'JE ME COMPTE — On est là, on se compte', description: DEFAULT_DESCRIPTION, path: pathname };
}
