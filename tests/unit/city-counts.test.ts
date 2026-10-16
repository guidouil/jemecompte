import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../../src/lib/server/db', () => ({ transaction: database.transaction, realEventsApproved: () => false }));
import { geometrySha256, executeCityCountsBatch, validateCityCountsBatch, verifyCityCountSources } from '../../src/lib/server/city-counts';
import { parseCityCountsArgs, runCityCounts } from '../../scripts/city-counts';

const filename = new URL('../../data/events/2026-10-17-cities.json', import.meta.url);
const sourcesFile = new URL('../../data/events/2026-10-17-cities.sources.json', import.meta.url);
beforeEach(() => database.transaction.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('reviewable city data pack', () => {
  it('validates all twenty exact administrative contours and their independently recorded source checksums', async () => {
    const configs = validateCityCountsBatch(JSON.parse(await readFile(filename, 'utf8')));
    const sources = JSON.parse(await readFile(sourcesFile, 'utf8'));
    verifyCityCountSources(configs, sources);
    expect(configs).toHaveLength(20);
    expect(new Set(configs.map((config) => config.id)).size).toBe(20);
    expect(configs.every((config) => config.countingScope === 'city' && !config.isTest)).toBe(true);
    expect(configs.every((config) => config.startsAt === '2026-10-17T05:00:00Z' && config.endsAt === '2026-10-17T17:00:00Z')).toBe(true);
    expect(configs.filter((config) => config.geofence.type === 'MultiPolygon').map((config) => config.cityName))
      .toEqual(['Marseille', 'Toulon', 'Saint-Étienne']);
    expect(sources.communes.every((entry: { populationMunicipale2023: number }) => entry.populationMunicipale2023 > 150_000)).toBe(true);
    const changed = structuredClone(configs);
    changed[0]!.geofence = { type: 'Polygon', coordinates: [] };
    expect(() => verifyCityCountSources(changed, sources)).toThrow('empreinte');
  });

  it('performs the default CLI dry run without entering a database transaction or making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await runCityCounts([]);
    expect(result).toMatchObject({ action: 'dry-run', databaseAccess: false, writes: false, draftsToPrepare: 20 });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate identities, public links, city codes, gathering scopes and test modes', async () => {
    const [config] = JSON.parse(await readFile(filename, 'utf8'));
    expect(() => validateCityCountsBatch([config, config])).toThrow('double');
    expect(() => validateCityCountsBatch([{ ...config, isTest: true }])).toThrow('isTest false');
    expect(() => validateCityCountsBatch([{ ...config, countingScope: 'gathering' }])).toThrow();
    expect(() => validateCityCountsBatch([{ ...config, id: undefined }])).toThrow('UUID stable');
    expect(geometrySha256({ type: 'Polygon', coordinates: [] })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not connect for real publication while approval is disabled', async () => {
    const [config] = JSON.parse(await readFile(filename, 'utf8'));
    await expect(executeCityCountsBatch([config], 'publish', { operator: 'test', reason: 'Test explicite' })).rejects.toThrow('désactivée');
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

it('keeps dry run as the default and rejects ambiguous or incomplete mutation flags', () => {
  expect(parseCityCountsArgs([]).action).toBe('dry-run');
  expect(parseCityCountsArgs(['--apply']).action).toBe('apply');
  expect(parseCityCountsArgs(['--publish']).action).toBe('publish');
  expect(() => parseCityCountsArgs(['--apply', '--publish'])).toThrow('seule action');
  expect(() => parseCityCountsArgs(['--dry-run', '--apply'])).toThrow('seule action');
  expect(() => parseCityCountsArgs(['--file'])).toThrow('valeur');
  expect(() => parseCityCountsArgs(['--unexpected'])).toThrow('Usage');
});
