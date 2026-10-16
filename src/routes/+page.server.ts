import { publicCatalogue, publicNationalTotal } from '#lib/server/public-data';
import { withReadBudget } from '#lib/server/abuse';

export async function load() {
  try {
    const [events, nationalTotal] = await withReadBudget(() => Promise.all([publicCatalogue(), publicNationalTotal()]));
    return { events, selectedEvent: null, snapshot: null, nationalTotal, serviceAvailable: true };
  } catch {
    return { events: [], selectedEvent: null, snapshot: null, nationalTotal: '0', serviceAvailable: false };
  }
}
