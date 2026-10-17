import { publicCatalogue, publicNationalTotals } from '#lib/server/public-data';
import { withReadBudget } from '#lib/server/abuse';

export async function load() {
  try {
    const [events, gatherings, cities] = await withReadBudget(() => Promise.all([
      publicCatalogue(), publicNationalTotals(), publicNationalTotals('city')
    ]));
    return { events, selectedEvent: null, snapshot: null, nationalTotal: gatherings.total, nationalCityTotal: cities.total,
      nationalSupportTotal: gatherings.supportTotal, nationalCitySupportTotal: cities.supportTotal,
      nationalLoadedAt: new Date().toISOString(), serviceAvailable: true };
  } catch {
    return { events: [], selectedEvent: null, snapshot: null, nationalTotal: '0', nationalCityTotal: '0',
      nationalSupportTotal: '0', nationalCitySupportTotal: '0', nationalLoadedAt: null, serviceAvailable: false };
  }
}
