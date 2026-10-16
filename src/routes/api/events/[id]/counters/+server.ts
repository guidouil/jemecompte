import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { publicCounterSnapshot } from '#lib/server/public-data';
import { withReadBudget } from '#lib/server/abuse';
import { parseEventId, RequestFailure } from '#lib/server/http';

export const GET: RequestHandler = async ({ params }) => {
  try {
    const snapshot = await withReadBudget(() => publicCounterSnapshot(parseEventId(params.id)));
    return snapshot
      ? json(snapshot, { headers: { 'cache-control': 'public, max-age=3' } })
      : json({ status: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  } catch (failure) {
    if (failure instanceof RequestFailure) return failure.response;
    return json({ status: 'temporarily_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '3' } });
  }
};
