import { publicBuildProvenance } from '#lib/server/build-provenance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store, max-age=0' });
  return { provenance: await publicBuildProvenance() };
};
