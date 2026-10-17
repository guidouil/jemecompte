import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { adminAuthenticated, adminConfigured, adminLoginLimiter, clearAdminSession, setAdminSession, verifyAdminPassword } from '#lib/server/admin-auth';
import { readAdminForm, sameAdminOrigin } from '#lib/server/admin-http';
import { deleteAdminEvent, listAdminEvents } from '#lib/server/admin-events';

export const load: PageServerLoad = async ({ cookies, url }) => {
  const configured = adminConfigured();
  const authenticated = adminAuthenticated(cookies);
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 120);
  const requestedPage = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 10_000) : 1;
  if (!authenticated) return { configured, authenticated: false, events: [], page: 1, hasNext: false, query: '' };
  try {
    return { configured, authenticated: true, query, ...await listAdminEvents({ page, q: query }) };
  } catch {
    return { configured, authenticated: true, events: [], page, hasNext: false, query,
      loadError: 'La liste est momentanément indisponible. Actualisez la page pour réessayer.' };
  }
};

export const actions: Actions = {
  login: async (event) => {
    if (!sameAdminOrigin(event)) return fail(403, { error: 'Requête refusée. Rechargez cette page.' });
    if (!adminConfigured()) return fail(503, { error: 'L’accès privé n’est pas encore configuré sur ce serveur.' });
    const release = adminLoginLimiter.acquire(event.getClientAddress());
    if (!release) {
      event.setHeaders({ 'retry-after': '60' });
      return fail(429, { error: 'Trop de tentatives. Patientez une minute avant de réessayer.' });
    }
    try {
      const form = await readAdminForm(event.request);
      if (!form || !await verifyAdminPassword(form.get('adminPassword'))) return fail(400, { error: 'Mot de passe incorrect.' });
      setAdminSession(event);
    } catch {
      return fail(503, { error: 'Connexion momentanément indisponible. Réessayez dans un instant.' });
    } finally { release(); }
    redirect(303, '/gui');
  },
  logout: async (event) => {
    if (!sameAdminOrigin(event)) return fail(403, { error: 'Requête refusée. Rechargez cette page.' });
    clearAdminSession(event.cookies);
    redirect(303, '/gui');
  },
  delete: async (event) => {
    if (!sameAdminOrigin(event)) return fail(403, { error: 'Requête refusée. Rechargez cette page.' });
    if (!adminAuthenticated(event.cookies)) return fail(401, { error: 'Votre session a expiré. Reconnectez-vous.' });
    const form = await readAdminForm(event.request);
    const eventId = form?.get('eventId');
    const confirmation = form?.get('confirmation');
    if (typeof eventId !== 'string' || typeof confirmation !== 'string' || confirmation.length > 100) {
      return fail(400, { error: 'La confirmation de suppression est invalide.' });
    }
    const release = adminLoginLimiter.acquire(event.getClientAddress(), Date.now(), 'delete');
    if (!release) {
      event.setHeaders({ 'retry-after': '60' });
      return fail(429, { error: 'Trop de tentatives. Patientez une minute avant de réessayer.', failedEventId: eventId, confirmation });
    }
    try {
      if (!await verifyAdminPassword(form?.get('adminPassword'))) {
        return fail(400, { error: 'Mot de passe incorrect. La suppression nécessite une nouvelle confirmation du mot de passe.', failedEventId: eventId, confirmation });
      }
      // The session can expire or be revoked while the body or password is being verified.
      if (!adminAuthenticated(event.cookies)) return fail(401, { error: 'Votre session a expiré. Reconnectez-vous.' });
      const result = await deleteAdminEvent(eventId, confirmation, { operator: 'gui-owner', reason: 'Suppression confirmée depuis l’espace privé.' });
      if (result.status === 'confirmation_mismatch') return fail(400, { error: 'Le texte de confirmation ne correspond pas au comptage.', failedEventId: eventId, confirmation });
      if (result.status === 'not_found') return fail(404, { error: 'Ce comptage a déjà été supprimé ou n’existe plus.', failedEventId: eventId, confirmation });
      return { message: 'Le comptage, toutes ses participations et ses compteurs ont été supprimés.', deletedId: eventId };
    } catch {
      return fail(503, { error: 'La suppression n’a pas pu être confirmée. Actualisez la liste avant de réessayer.', failedEventId: eventId, confirmation });
    } finally { release(); }
  }
};
