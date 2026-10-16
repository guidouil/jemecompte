import type { RequestHandler } from './$types';
import { getPublicTile, parseTile } from '#lib/server/maps';

export const GET: RequestHandler = async ({ params, url }) => {
  const tile = parseTile(params.z, params.x, params.y);
  if (!tile || url.search) return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } });
  try {
    const bytes = await getPublicTile(tile);
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: {
      'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff'
    } });
  } catch {
    return new Response(null, { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '3' } });
  }
};
