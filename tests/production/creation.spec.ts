import { test, expect, type Page } from '@playwright/test';

// Focus this test on the built application's CSP. The separate PWA suite exercises its worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Los_Angeles' });
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

async function mapViewport(page: Page) {
  await page.waitForFunction(() => {
    const map = document.querySelector('.creation-map');
    return map && !map.classList.contains('leaflet-zoom-anim') && map.querySelector('img.leaflet-tile-loaded');
  });
  return page.locator('.creation-map').evaluate((container) => {
    const pane = container.querySelector<HTMLElement>('.leaflet-map-pane');
    const levels = [...container.querySelectorAll<HTMLElement>('.leaflet-tile-container')]
      .filter((level) => level.querySelector('img.leaflet-tile-loaded') && getComputedStyle(level).opacity !== '0')
      .sort((a, b) => Number(getComputedStyle(b).zIndex) - Number(getComputedStyle(a).zIndex));
    const activeLevel = levels[0];
    const image = activeLevel?.querySelector<HTMLImageElement>('img.leaflet-tile-loaded');
    const zoom = image?.src.match(/\/api\/map\/tiles\/(\d+)\//)?.[1];
    if (!pane || !activeLevel || !zoom) throw new Error('Expected a loaded map viewport.');
    return { zoom: Number(zoom), mapTransform: pane.style.transform, tileTransform: activeLevel.style.transform };
  });
}

test('production map remains interactive under CSP, uses same-origin providers and never requests GPS', async ({ page }) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    let geoCalls = 0;
    Object.defineProperty(window, '__mapPrivacy', { get: () => ({ violations, geoCalls }) });
    window.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
    navigator.geolocation.getCurrentPosition = () => { geoCalls += 1; throw new Error('Creation must not request GPS.'); };
  });
  const externalRequests: string[] = [];
  const creationRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== 'http://127.0.0.1:5176') externalRequests.push(request.url());
      if (url.pathname === '/api/events/create') creationRequests.push(request.url());
    }
  });
  await page.route('**/api/places?**', (route) => route.fulfill({
    json: { places: [{ code: '75056', name: 'Paris', center: [2.365, 48.865] }] }
  }));
  await page.route('**/api/map/tiles/**', (route) => route.fulfill({ contentType: 'image/png', body: tile }));
  const response = await page.goto('/creer');
  expect(response?.headers()['content-security-policy']).toContain("object-src 'none'");
  await page.getByLabel('Ville du rassemblement').fill('Paris');
  await page.getByRole('button', { name: 'Chercher', exact: true }).click();
  await page.getByRole('button', { name: /^Paris Code commune 75056/ }).click();
  const place = page.getByRole('button', { name: /Placer la zone au centre de la carte/ });
  await expect(place).toBeEnabled();
  const initialViewport = await mapViewport(page);
  await page.getByRole('button', { name: 'Agrandir la carte' }).click();
  await expect.poll(async () => (await mapViewport(page)).zoom).toBe(initialViewport.zoom + 1);
  const manuallyChosenViewport = await mapViewport(page);
  // A point selection redraws the zone; it must preserve the user's own map view.
  await page.locator('.creation-map').click({ position: { x: 100, y: 160 } });
  await expect(page.getByText(/Zone sélectionnée à Paris/)).toBeVisible();
  const marker = page.locator('.creation-map svg path').last();
  await expect(marker).toBeVisible();
  expect(await mapViewport(page)).toEqual(manuallyChosenViewport);
  const firstMarker = await marker.getAttribute('d');
  await page.locator('.creation-map').click({ position: { x: 200, y: 220 } });
  await expect(marker).not.toHaveAttribute('d', firstMarker!);
  expect(await mapViewport(page)).toEqual(manuallyChosenViewport);
  const secondMarker = await marker.getAttribute('d');
  await place.click();
  await expect(marker).not.toHaveAttribute('d', secondMarker!);
  expect(await mapViewport(page)).toEqual(manuallyChosenViewport);
  await page.getByRole('button', { name: /^Continuer/ }).click();
  await page.getByLabel('Nom public du rassemblement').fill('Prévisualisation fictive CSP');
  const radius = page.getByLabel('Rayon autour du lieu');
  await expect(radius).toHaveValue('500');
  await radius.fill('10000');
  await expect(page.getByLabel('Durée du comptage', { exact: true })).toHaveValue('240');
  await expect(page.getByRole('radio', { name: 'Maintenant', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Choisir la date et l’heure', exact: true }).check();
  await page.getByLabel('Date de début', { exact: true }).fill('2099-07-18');
  await page.getByLabel('Heure de début', { exact: true }).fill('14:30');
  await expect(page.getByText('Heure de Paris (Europe/Paris), même si votre appareil utilise un autre fuseau.')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 850 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('heading', { name: 'Délimitez le comptage' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('creation-mobile-schedule-fields.png'), fullPage: true });
  await page.getByRole('button', { name: /^Vérifier le comptage/ }).click();
  await expect(page.locator('dl.review > div').filter({ has: page.locator('dt', { hasText: /^Début$/ }) }).locator('dd')).toContainText('14:30');
  await expect(page.locator('dl.review > div').filter({ has: page.locator('dt', { hasText: /^Fin$/ }) }).locator('dd')).toContainText('18:30');
  await expect(page.locator('dl.review > div').filter({ has: page.locator('dt', { hasText: /^Durée$/ }) }).locator('dd')).toContainText('4 heures');
  await expect(page.getByText(/^Cercle de (?:10[\s\u202f]?000 mètres|10 km) de rayon$/)).toBeVisible();
  await expect(page.locator('.creation-map svg path').first()).toBeVisible();
  await expect.poll(() => page.locator('.creation-map').evaluate((container) => {
    const outline = container.querySelector('svg path');
    if (!outline) return false;
    const map = container.getBoundingClientRect();
    const zone = outline.getBoundingClientRect();
    return zone.width > 20 && zone.height > 20 && zone.left >= map.left && zone.top >= map.top &&
      zone.right <= map.right && zone.bottom <= map.bottom;
  })).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('creation-mobile-preview.png'), fullPage: true });
  expect(await page.evaluate(() => (window as unknown as {
    __mapPrivacy: { violations: string[]; geoCalls: number }
  }).__mapPrivacy)).toEqual({ violations: [], geoCalls: 0 });
  expect(externalRequests).toEqual([]);
  expect(creationRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
