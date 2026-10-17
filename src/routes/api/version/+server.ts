import { json } from '@sveltejs/kit';
import { publicBuildProvenance } from '#lib/server/build-provenance';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json(await publicBuildProvenance(), {
  headers: { 'cache-control': 'no-store, max-age=0', 'x-robots-tag': 'noindex' }
});
