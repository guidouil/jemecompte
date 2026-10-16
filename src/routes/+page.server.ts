import { publicCatalogue, publicNationalTotal } from '#lib/server/public-data';
import { withReadBudget } from '#lib/server/abuse';

export async function load() {
  try {
    const [events, nationalTotal, nationalCityTotal] = await withReadBudget(() => Promise.all([
      publicCatalogue(), publicNationalTotal(), publicNationalTotal('city')
    ]));
    return { events, selectedEvent: null, snapshot: null, nationalTotal, nationalCityTotal, nationalLoadedAt: new Date().toISOString(), serviceAvailable: true };
  } catch {
    return { events: [], selectedEvent: null, snapshot: null, nationalTotal: '0', nationalCityTotal: '0', nationalLoadedAt: null, serviceAvailable: false };
  }
}
