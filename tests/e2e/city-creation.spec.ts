import { test, expect, type Page } from '@playwright/test';
import { EVENT_CREATION_DRAFT_KEY } from '../../src/lib/client/event-creation-draft';

test.use({ viewport: { width: 320, height: 850 } });

const city = { code: '06088', name: 'Commune fictive de recette', center: [7.31, 43.71] };
const boundary = { ...city, geofence: { type: 'MultiPolygon', coordinates: [
  [[[7.30, 43.70], [7.32, 43.70], [7.32, 43.72], [7.30, 43.72], [7.30, 43.70]]],
  [[[7.35, 43.70], [7.36, 43.70], [7.36, 43.71], [7.35, 43.71], [7.35, 43.70]]]
] } };
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

interface CreationPrivacy { geolocation: number; identity: number }
interface CreationTestWindow extends Window { __cityCreationPrivacy: CreationPrivacy }

async function observePrivacy(page: Page) {
  await page.addInitScript(() => {
    const state = { geolocation: 0, identity: 0 };
    (window as unknown as CreationTestWindow).__cityCreationPrivacy = state;
    const locate = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (...args) => { state.geolocation += 1; return locate(...args); };
    navigator.geolocation.watchPosition = (...args) => { state.geolocation += 1; return watch(...args); };
    const generateKey = crypto.subtle.generateKey.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true,
      value: (...args: Parameters<SubtleCrypto['generateKey']>) => {
        state.identity += 1;
        return Reflect.apply(generateKey, crypto.subtle, args);
      } });
  });
  const participationRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/(?:presences|presence-status)(?:$|\?)/.test(request.url())) participationRequests.push(request.url());
  });
  return participationRequests;
}

async function expectNoParticipation(page: Page, requests: string[]) {
  expect(await page.evaluate(() => (window as unknown as CreationTestWindow).__cityCreationPrivacy))
    .toEqual({ geolocation: 0, identity: 0 });
  expect(requests).toEqual([]);
}

async function mockSearchAndTiles(page: Page) {
  await page.route('**/api/places?**', (route) => route.fulfill({ json: { places: [city] } }));
  await page.route('**/api/map/tiles/**', (route) => route.fulfill({ contentType: 'image/png', body: tile }));
}

async function selectCity(page: Page) {
  await page.goto('/creer');
  await expect(page.getByRole('radio', { name: 'Commune entière', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Rassemblement localisé', exact: true })).not.toBeChecked();
  await page.getByLabel('Ville du comptage', { exact: true }).fill(city.name);
  await page.getByRole('button', { name: 'Chercher', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${city.name} Code commune ${city.code}`) }).click();
}

async function expectWholeBoundaryVisible(page: Page) {
  const outline = page.locator('path.creation-city-boundary');
  await expect(outline).toBeVisible();
  await expect.poll(() => outline.getAttribute('d').then((path) => path?.match(/M/g)?.length ?? 0)).toBe(2);
  await expect.poll(() => outline.evaluate((element) => {
    const container = element.closest('.creation-map');
    if (!container) return false;
    const mapBounds = container.getBoundingClientRect();
    const boundaryBounds = element.getBoundingClientRect();
    return boundaryBounds.width > 20 && boundaryBounds.height > 20 &&
      boundaryBounds.left >= mapBounds.left && boundaryBounds.top >= mapBounds.top &&
      boundaryBounds.right <= mapBounds.right && boundaryBounds.bottom <= mapBounds.bottom;
  })).toBe(true);
  await expect(page.locator('.creation-map')).toHaveAttribute('aria-label', 'Carte du contour administratif de la commune entière.');
  await expect(page.locator('path.creation-gathering-boundary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Placer la zone au centre/ })).toHaveCount(0);
  await expect(page.getByLabel('Rayon autour du lieu')).toHaveCount(0);
}

test('creates a whole-city request without a radius and recovers the exact request despite a failed boundary reload', async ({ page }) => {
  const participationRequests = await observePrivacy(page);
  await mockSearchAndTiles(page);
  let boundaryUnavailable = false;
  let boundaryRequests = 0;
  await page.route(`**/api/places/${city.code}/boundary`, (route) => {
    boundaryRequests += 1;
    return route.fulfill(boundaryUnavailable
      ? { status: 503, json: { status: 'temporarily_unavailable' } }
      : { json: boundary });
  });
  const bodies: string[] = [];
  // Every creation stays in the browser fixture; no event is written to the server.
  await page.route('**/api/events/create', (route) => {
    bodies.push(route.request().postData()!);
    return route.fulfill({ status: 503, json: { status: 'temporarily_unavailable' } });
  });

  await selectCity(page);
  await expect(page.getByText(`Toute la commune de ${city.name} est sélectionnée, selon son contour administratif.`, { exact: true })).toBeVisible();
  await expectWholeBoundaryVisible(page);
  const next = page.getByRole('button', { name: /^Continuer/ });
  await expect(next).toBeEnabled();
  await next.click();
  const name = 'Comptage fictif de commune entière';
  await page.getByLabel('Nom public du comptage', { exact: true }).fill(name);
  await expect(page.getByLabel('Rayon autour du lieu')).toHaveCount(0);
  await page.getByLabel('Durée du comptage', { exact: true }).selectOption('120');
  await page.getByRole('button', { name: /^Vérifier le comptage/ }).click();
  await expect(page.locator('dl.review')).toContainText(`Commune entière de ${city.name} · contour administratif`);
  await expect(page.locator('dl.review')).toContainText('2 heures écoulées');
  await expectWholeBoundaryVisible(page);
  await expect(page.getByRole('button', { name: /^Créer le comptage/ })).toBeDisabled();
  await page.getByRole('checkbox', { name: /^Je confirme un comptage dans toute la commune/ }).check();
  await expectNoParticipation(page, participationRequests);
  expect(bodies).toEqual([]);
  await page.getByRole('button', { name: /^Créer le comptage/ }).click();
  await expect(page.getByText('Le contour de la commune est momentanément indisponible. Réessayez ici : la même demande est conservée.', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(1);
  const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    'cityCode', 'cityName', 'countingScope', 'durationMinutes', 'name', 'publicLocationConfirmed', 'requestId'
  ]);
  expect(body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), name,
    cityCode: city.code, cityName: city.name, countingScope: 'city', durationMinutes: 120, publicLocationConfirmed: true });
  const draft = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), EVENT_CREATION_DRAFT_KEY);
  expect(draft).toMatchObject({ version: 1, payload: body });
  expect(Object.keys(draft).sort()).toEqual(['payload', 'savedAt', 'version']);
  await expectNoParticipation(page, participationRequests);

  boundaryUnavailable = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reprendre la même demande', exact: true })).toBeVisible();
  await expect(page.getByText(/aucun nouvel envoi n’est automatique/)).toBeVisible();
  await expect(page.getByText('Le contour de la commune n’a pas pu être chargé. Réessayez pour sélectionner la ville entière.', { exact: true })).toBeVisible();
  expect(boundaryRequests).toBe(2);
  expect(bodies).toHaveLength(1);
  await expect(page.locator('dl.review')).toContainText(name);
  await expect(page.locator('dl.review')).toContainText(`Commune entière de ${city.name} · contour administratif`);
  await expect(page.getByRole('button', { name: /Modifier le comptage/ })).toBeDisabled();
  const retry = page.getByRole('button', { name: /^Reprendre la même demande/ });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByText('Le contour de la commune est momentanément indisponible. Réessayez ici : la même demande est conservée.', { exact: true })).toBeVisible();
  expect(bodies).toEqual([bodies[0], bodies[0]]);
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), EVENT_CREATION_DRAFT_KEY)).toEqual(draft);
  await expectNoParticipation(page, participationRequests);
});

test('requires an explicit retry after the first city boundary fails before enabling Continue', async ({ page }) => {
  const participationRequests = await observePrivacy(page);
  await mockSearchAndTiles(page);
  let boundaryRequests = 0;
  await page.route(`**/api/places/${city.code}/boundary`, (route) => {
    boundaryRequests += 1;
    return route.fulfill(boundaryRequests === 1
      ? { status: 503, json: { status: 'temporarily_unavailable' } }
      : { json: boundary });
  });
  const creations: string[] = [];
  await page.route('**/api/events/create', (route) => {
    creations.push(route.request().postData()!);
    return route.fulfill({ status: 503, json: { status: 'temporarily_unavailable' } });
  });

  await selectCity(page);
  const next = page.getByRole('button', { name: /^Continuer/ });
  await expect(page.getByText('Le contour de la commune n’a pas pu être chargé. Réessayez pour sélectionner la ville entière.', { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await expect(page.locator('path.creation-city-boundary')).toHaveCount(0);
  expect(boundaryRequests).toBe(1);
  await page.getByRole('button', { name: 'Réessayer le chargement du contour', exact: true }).click();
  await expectWholeBoundaryVisible(page);
  await expect(next).toBeEnabled();
  expect(boundaryRequests).toBe(2);
  await next.click();
  await expect(page.getByLabel('Nom public du comptage', { exact: true })).toBeVisible();
  expect(creations).toEqual([]);
  await expectNoParticipation(page, participationRequests);
});
