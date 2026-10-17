import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPublicPlaceBoundary } from '#lib/server/maps';

export const GET: RequestHandler = async ({ params, url }) => {
  if (!/^[0-9AB]{5}$/.test(params.code) || url.searchParams.size > 0) {
    return json({ status: 'invalid_request' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  try {
    return json(await getPublicPlaceBoundary(params.code), { headers: { 'cache-control': 'public, max-age=86400' } });
  } catch {
    return json({ status: 'temporarily_unavailable' }, {
      status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '3' }
    });
  }
};
