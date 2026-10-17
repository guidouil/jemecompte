import { publicOrigin } from '#lib/shared/seo';

export function load() {
  return { publicOrigin: publicOrigin(process.env.ORIGIN) };
}
