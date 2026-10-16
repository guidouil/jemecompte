import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { normalizePlaceQuery, searchPublicPlaces } from '#lib/server/maps';

export const GET: RequestHandler = async ({ url }) => {
  // This endpoint accepts a town name only, never coordinates or an arbitrary upstream URL.
  if ([...url.searchParams.keys()].some((key) => key !== 'q') || url.searchParams.getAll('q').length !== 1) {
    return json({ places: [], status: 'invalid_request' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  const query = normalizePlaceQuery(url.searchParams.get('q') ?? '');
  if (!query) return json({ places: [], status: 'invalid_request' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  try {
    return json({ places: await searchPublicPlaces(query) }, { headers: { 'cache-control': 'public, max-age=3600' } });
  } catch {
    return json({ places: [], status: 'temporarily_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '3' } });
  }
};
