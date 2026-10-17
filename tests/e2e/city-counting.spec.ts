import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Pool } from 'pg';
import type { ParticipationPayload } from '../../src/lib/shared/types';

test.use({ viewport: { width: 320, height: 850 } });

const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith('_test')) throw new Error('City browser tests require a dedicated _test database.');
const pool = new Pool({ connectionString: database, max: 2 });
const cityId = randomUUID();
const gatheringId = randomUUID();
const citySlug = `city-${cityId}`;
const cityName = `Comptage de commune fictive ${cityId.slice(0, 8)}`;
const cityPolygon = { type: 'MultiPolygon', coordinates: [
  [[[7.30, 43.70], [7.32, 43.70], [7.32, 43.72], [7.30, 43.72], [7.30, 43.70]]],
  [[[7.35, 43.70], [7.36, 43.70], [7.36, 43.71], [7.35, 43.71], [7.35, 43.70]]]
] };
const gatheringPolygon = { type: 'Polygon', coordinates: [[[2.36, 48.86], [2.37, 48.86], [2.37, 48.87], [2.36, 48.87], [2.36, 48.86]]] };

interface CityPrivacy { geolocation: number; identity: number; prints: string[] }
interface CityTestWindow extends Window { __cityPrivacy: CityPrivacy }

async function observe(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ longitude: 7.31, latitude: 43.71, accuracy: 20 });
  await page.addInitScript(() => {
    const root = window.top as unknown as CityTestWindow;
    root.__cityPrivacy ??= { geolocation: 0, identity: 0, prints: [] };
    const state = root.__cityPrivacy;
    const locate = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (...args) => { state.geolocation += 1; return locate(...args); };
    const generateKey = crypto.subtle.generateKey.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true,
      value: (...args: Parameters<SubtleCrypto['generateKey']>) => {
        state.identity += 1;
        return Reflect.apply(generateKey, crypto.subtle, args);
      } });
    window.print = () => state.prints.push(document.body.textContent ?? '');
  });
  const submissions: ParticipationPayload[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/presences')) submissions.push(request.postDataJSON() as ParticipationPayload);
  });
  return submissions;
}

async function count(eventId: string) {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM presences WHERE event_id=$1', [eventId]);
  return Number(result.rows[0]?.count ?? '0');
}

test.beforeAll(async () => {
  for (const [id, slug, name, scope, polygon] of [
    [cityId, citySlug, cityName, 'city', cityPolygon],
    [gatheringId, `city-gathering-${gatheringId}`, 'Rassemblement localisé fictif', 'gathering', gatheringPolygon]
  ] as const) {
    await pool.query(`INSERT INTO events
      (id,slug,name,city_code,city_name,geofence,counting_scope,starts_at,ends_at,status,is_test)
      VALUES ($1,$2,$3,'06088','Commune fictive de recette',$4,$5,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
    [id, slug, name, polygon, scope]);
  }
});

test.afterAll(async () => {
  try {
    for (const id of [cityId, gatheringId]) {
      await pool.query('DELETE FROM admin_audit WHERE event_id=$1', [id]);
      await pool.query('DELETE FROM presences WHERE event_id=$1', [id]);
      await pool.query('DELETE FROM event_counters WHERE event_id=$1', [id]);
      await pool.query('DELETE FROM events WHERE id=$1', [id]);
    }
  } finally { await pool.end(); }
});

test('home requires an explicit whole-city choice before generating an identity or submitting a single city match', async ({ page, request }) => {
  const submissions = await observe(page);
  await expect.poll(async () => {
    const response = await request.get('/api/events');
    return (await response.json()).events?.some((event: { id: string }) => event.id === cityId);
  }, { timeout: 12_000 }).toBe(true);
  await page.goto('/');
  await expect(page.locator('.national-count[data-counting-scope="gathering"]')).toContainText('RASSEMBLEMENTS LOCALISÉS');
  await expect(page.locator('.national-count[data-counting-scope="city"]')).toContainText('COMMUNES ENTIÈRES');
  await page.getByLabel('Nom ou ville', { exact: true }).fill(cityName);
  const result = page.locator('.discovery-result').filter({ hasText: cityName });
  await expect(result).toContainText('COMMUNE ENTIÈRE');
  await expect(result).toContainText('Aucun lieu de manifestation confirmé');
  const before = await count(cityId);
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.getByRole('heading', { name: 'Confirmer ce comptage de commune', exact: true })).toBeVisible();
  expect(submissions).toEqual([]);
  expect((await page.evaluate(() => (window as unknown as CityTestWindow).__cityPrivacy)).identity).toBe(0);
  expect(await count(cityId)).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: new RegExp(`${cityName}.*ME COMPTER DANS CETTE VILLE`) }).click();
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(Object.keys(submissions[0]!).sort()).toEqual(['admission', 'anonymousEventId', 'countingScope', 'geofenceVersion', 'insideZone', 'protocolVersion']);
  expect(submissions[0]!.countingScope).toBe('city');
  await expect(page.locator('.counter-caption')).toContainText('participations et soutiens');
  await expect(page.locator('.counter-caption')).toContainText('pour ce comptage de commune');
  await expect(page.locator('.counter-caption')).not.toContainText('personnes');
  await expect(page.locator('.national-count')).toHaveCount(1);
  await expect(page.locator('.national-count')).toHaveAttribute('data-counting-scope', 'city');
  expect(await count(cityId)).toBe(before + 1);
  expect(await count(gatheringId)).toBe(0);
});

test('the whole-city page names its scope and allows only the explicit city action', async ({ page }) => {
  const submissions = await observe(page);
  await page.goto(`/evenements/${citySlug}`);
  await expect(page.locator('.event-meta')).toContainText('COMMUNE ENTIÈRE');
  await expect(page.locator('.event-context')).toContainText('Fenêtre de comptage');
  await expect(page.locator('#city-scope-note')).toContainText('ne confirme aucun lieu ni horaire de manifestation');
  await expect(page.locator('#city-scope-note')).toContainText('ne prouve pas une participation');
  await expect(page.getByRole('button', { name: /^JE ME COMPTE/ })).toHaveCount(0);
  const action = page.getByRole('button', { name: 'ME COMPTER DANS CETTE VILLE', exact: true });
  await expect(action).toBeEnabled();
  expect(submissions).toEqual([]);
  expect((await page.evaluate(() => (window as unknown as CityTestWindow).__cityPrivacy)).geolocation).toBe(0);
  const before = await count(cityId);
  await action.click();
  await expect(page.locator('#participation-feedback')).toContainText('participations déclarées dans cette commune');
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.countingScope).toBe('city');
  expect(await count(cityId)).toBe(before + 1);
  await expect(page.getByRole('heading', { name: 'Confirmer ce comptage de commune', exact: true })).toHaveCount(0);
});

test('city QR and printed sheet explain the commune scope without GPS, identity or participation', async ({ page }) => {
  const submissions = await observe(page);
  const before = await count(cityId);
  await page.goto(`/evenements/${citySlug}`);
  await page.getByRole('button', { name: 'Afficher le QR code', exact: true }).click();
  await expect(page.locator('.qr-image')).toBeVisible();
  await expect(page.locator('.qr-heading')).toHaveText('Comptage de commune entière');
  await expect(page.locator('.qr-description')).toContainText('ne prouve pas une participation à une manifestation');
  await page.getByRole('button', { name: 'Imprimer l’affiche', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as CityTestWindow).__cityPrivacy.prints.length)).toBe(1);
  const state = await page.evaluate(() => (window as unknown as CityTestWindow).__cityPrivacy);
  expect(state.prints[0]).toContain('Comptage dans toute la commune');
  expect(state.prints[0]).toContain('Me compter dans cette ville');
  expect(state.prints[0]).toContain('ne prouve pas une participation à une manifestation');
  expect(state.prints[0]).toContain('Fenêtre de comptage');
  expect(state.prints[0]).not.toContain('Sur place');
  expect(state.geolocation).toBe(0);
  expect(state.identity).toBe(0);
  expect(submissions).toEqual([]);
  expect(await count(cityId)).toBe(before);
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.event-qr-print-frame')?.contentWindow?.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.event-qr-print-frame')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the commune perimeter keeps both disjoint territories visible without a radius or a participation', async ({ page }) => {
  const submissions = await observe(page);
  const before = await count(cityId);
  const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  await page.route('**/api/map/tiles/**', (route) => route.fulfill({ contentType: 'image/png', body: tile }));
  await page.goto(`/evenements/${citySlug}`);
  await expect(page.locator('.event-perimeter')).toContainText('Toute la commune');
  await expect(page.locator('.event-perimeter')).not.toContainText('Rayon');
  await page.getByRole('button', { name: 'Voir le périmètre', exact: true }).click();
  const outline = page.locator('path.public-event-perimeter');
  await expect(outline).toBeVisible();
  await expect.poll(() => outline.getAttribute('d').then((path) => path?.match(/M/g)?.length ?? 0)).toBe(2);
  const state = await page.evaluate(() => (window as unknown as CityTestWindow).__cityPrivacy);
  expect(state.geolocation).toBe(0);
  expect(state.identity).toBe(0);
  expect(submissions).toEqual([]);
  expect(await count(cityId)).toBe(before);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('commune-mobile-320.png'), fullPage: true });
});
