import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEventBySlug } from '#lib/server/events';
import { publicCatalogue, publicCounterSnapshot } from '#lib/server/public-data';
import { withReadBudget } from '#lib/server/abuse';

export const load: PageServerLoad = async ({ params }) => withReadBudget(async () => {
  try {
    const selectedEvent = await getEventBySlug(params.slug);
    if (!selectedEvent) error(404, 'Cet événement est introuvable.');
    const [events, snapshot] = await Promise.all([publicCatalogue(), publicCounterSnapshot(selectedEvent.id)]);
    return {
      events: [selectedEvent, ...events.filter((event) => event.id !== selectedEvent.id)],
      selectedEvent, snapshot, nationalTotal: snapshot?.nationalTotal ?? '0',
      nationalSupportTotal: snapshot?.nationalSupportTotal, serviceAvailable: true
    };
  } catch (failure) {
    if (failure && typeof failure === 'object' && 'status' in failure && failure.status === 404) throw failure;
    error(503, 'Le service est momentanément indisponible. Réessayez dans un instant.');
  }
});
