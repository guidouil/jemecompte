import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CityCountsError, executeCityCountsBatch, validateCityCountsBatch, verifyCityCountSources } from '../src/lib/server/city-counts';

export function parseCityCountsArgs(args: string[]) {
  let action: 'dry-run' | 'apply' | 'publish' = 'dry-run';
  let explicitAction = false;
  let filename = fileURLToPath(new URL('../data/events/2026-10-17-cities.json', import.meta.url));
  let sources = fileURLToPath(new URL('../data/events/2026-10-17-cities.sources.json', import.meta.url));
  let reason = 'Préparation des comptages communaux du 17 octobre 2026, sans présence initiale';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--publish' || argument === '--dry-run') {
      if (explicitAction) throw new CityCountsError('Choisir une seule action : --dry-run, --apply ou --publish.');
      action = argument.slice(2) as typeof action;
      explicitAction = true;
    } else if (argument === '--file' || argument === '--sources' || argument === '--reason') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new CityCountsError(`Une valeur est requise après ${argument}.`);
      if (argument === '--file') filename = resolve(value);
      else if (argument === '--sources') sources = resolve(value);
      else reason = value;
    } else throw new CityCountsError('Usage : cities:prepare [--dry-run | --apply | --publish] [--file JSON --sources JSON] [--reason TEXTE].');
  }
  return { action, filename, sources, reason };
}

export async function runCityCounts(args: string[]): Promise<object> {
  const options = parseCityCountsArgs(args);
  const configs = validateCityCountsBatch(JSON.parse(await readFile(options.filename, 'utf8')));
  verifyCityCountSources(configs, JSON.parse(await readFile(options.sources, 'utf8')));
  if (options.action === 'dry-run') {
    return { validation: 'ok', action: 'dry-run', databaseAccess: false, writes: false,
      draftsToPrepare: configs.length, isTest: false, countingScope: 'city',
      events: configs.map(({ id, slug, cityName, startsAt, endsAt }) => ({ id, slug, cityName, startsAt, endsAt })) };
  }
  return executeCityCountsBatch(configs, options.action, { operator: process.env.ADMIN_OPERATOR ?? userInfo().username, reason: options.reason });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCityCounts(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(error instanceof CityCountsError ? error.message : 'Préparation échouée. Vérifier les fichiers, migrations et accès administratifs sans publier les paramètres SQL.');
    process.exitCode = 1;
  } finally {
    // getPool is lazy: this cleanup never opens a connection during the default dry run.
    const { closeDatabase } = await import('../src/lib/server/db');
    await closeDatabase();
  }
}
