import { publicCatalogue } from '#lib/server/public-data';
import { withReadBudget } from '#lib/server/abuse';

export async function load() {
  try {
    return { events: await withReadBudget(publicCatalogue), serviceAvailable: true };
  } catch {
    return { events: [], serviceAvailable: false };
  }
}
