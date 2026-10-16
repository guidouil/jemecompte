import { json } from '@sveltejs/kit';
import { publicCatalogue } from '#lib/server/public-data';
import { withReadBudget } from '#lib/server/abuse';
import { record } from '#lib/server/observability';

export async function GET() {
  try {
    return json({ events: await withReadBudget(publicCatalogue), serverTime: new Date().toISOString() }, {
      headers: { 'cache-control': 'public, max-age=10' }
    });
  } catch {
    record('unavailable');
    return json({ status: 'temporarily_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '3' } });
  }
}
