import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Pool } from 'pg';

test.use({ serviceWorkers: 'block' });

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) {
  throw new Error('Event tools browser tests require a dedicated TEST_DATABASE_URL ending in _test.');
}
const pool = new Pool({ connectionString: testUrl, max: 2 });
const eventId = randomUUID();
const slug = `event-tools-${eventId}`;
const eventName = `Outils du rassemblement fictif ${eventId.slice(0, 8)}`;
const eventPath = `/evenements/${slug}`;
const canonicalUrl = `http://127.0.0.1:5176${eventPath}`;
// A six-corner concave L: displaying a circle or a rectangular bbox would be incorrect.
const polygon = { type: 'Polygon', coordinates: [[
  [2.360, 48.860], [2.370, 48.860], [2.370, 48.863], [2.364, 48.863],
  [2.364, 48.870], [2.360, 48.870], [2.360, 48.860]
]] };
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

interface BrowserPrivacyState { geoCalls: number; violations: string[] }
interface SharedValue { url?: string; title?: string; text?: string }

async function installPrivacyGuard(page: Page) {
  await page.addInitScript(() => {
    let geoCalls = 0;
    const violations: string[] = [];
    Object.defineProperty(window, '__eventToolsPrivacy', { get: () => ({ geoCalls, violations }) });
    const rejectGps = () => { geoCalls += 1; throw new Error('Event tools must not request GPS.'); };
    navigator.geolocation.getCurrentPosition = rejectGps;
    navigator.geolocation.watchPosition = rejectGps;
    window.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
  });
  const forbiddenRequests: string[] = [];
  const externalRequests: string[] = [];
  const tileRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== 'http://127.0.0.1:5176') externalRequests.push(request.url());
      if (/\/presences$|\/presence-status$|\/events\/create$/.test(url.pathname)) forbiddenRequests.push(request.url());
      if (url.pathname.startsWith('/api/map/tiles/')) tileRequests.push(request.url());
    }
  });
  await page.route('**/api/map/tiles/**', (route) => route.fulfill({ contentType: 'image/png', body: tile }));
  return { forbiddenRequests, externalRequests, tileRequests };
}

async function openEvent(page: Page, polluted = false): Promise<void> {
  const response = await page.goto(`${eventPath}${polluted ? '?foo=not-for-sharing#not-for-sharing' : ''}`);
  expect(response?.headers()['content-security-policy']).toContain("object-src 'none'");
  await expect(page.getByRole('heading', { name: eventName, exact: true })).toBeVisible();
}

async function expectNoParticipation(page: Page, network: Awaited<ReturnType<typeof installPrivacyGuard>>): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as {
    __eventToolsPrivacy: BrowserPrivacyState
  }).__eventToolsPrivacy)).toEqual({ geoCalls: 0, violations: [] });
  expect(network.forbiddenRequests).toEqual([]);
  expect(network.externalRequests).toEqual([]);
  const result = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM presences WHERE event_id=$1', [eventId]);
  expect(result.rows[0]?.total).toBe('0');
}

test.beforeAll(async () => {
  await pool.query(`INSERT INTO events
    (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
    VALUES ($1,$2,$3,'75056','Paris',$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
  [eventId, slug, eventName, polygon]);
});

test.afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM presences WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM event_counters WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
  } finally { await pool.end(); }
});

test('shows the exact public perimeter only on demand without locating or counting anyone', async ({ page }) => {
  const network = await installPrivacyGuard(page);
  await openEvent(page);
  await expect(page.getByRole('button', { name: 'Voir le périmètre', exact: true })).toBeEnabled();
  expect(network.tileRequests).toEqual([]);
  await expect(page.locator('.leaflet-container')).toHaveCount(0);
  await expectNoParticipation(page, network);

  await page.getByRole('button', { name: 'Voir le périmètre', exact: true }).click();
  const outline = page.locator('path.public-event-perimeter');
  await expect(outline).toBeVisible();
  await expect.poll(() => network.tileRequests.length).toBeGreaterThan(0);
  await expect(page.getByText('Votre position n’est pas affichée sur cette carte.', { exact: true })).toBeVisible();
  await expect.poll(() => outline.evaluate((path) => {
    const map = path.closest('.leaflet-container');
    if (!map) return false;
    const mapBounds = map.getBoundingClientRect();
    const bounds = path.getBoundingClientRect();
    return bounds.width > 20 && bounds.height > 20 && bounds.left >= mapBounds.left &&
      bounds.top >= mapBounds.top && bounds.right <= mapBounds.right && bounds.bottom <= mapBounds.bottom;
  })).toBe(true);
  const shape = await outline.evaluate((path) => {
    const data = path.getAttribute('d') ?? '';
    const vertices = [...data.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/g)]
      .map((match) => [Number(match[1]), Number(match[2])]);
    const turnSigns = vertices.map((point, index) => {
      const next = vertices[(index + 1) % vertices.length]!;
      const after = vertices[(index + 2) % vertices.length]!;
      return Math.sign((next[0]! - point[0]!) * (after[1]! - next[1]!) -
        (next[1]! - point[1]!) * (after[0]! - next[0]!));
    });
    return { vertices: vertices.length, closed: /z\s*$/i.test(data), hasConcaveTurn: turnSigns.includes(1) && turnSigns.includes(-1) };
  });
  expect(shape).toEqual({ vertices: 6, closed: true, hasConcaveTurn: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('event-perimeter-mobile.png'), fullPage: true });

  await page.getByRole('button', { name: 'Masquer le périmètre', exact: true }).click();
  await expect(page.locator('.leaflet-container')).toHaveCount(0);
  await page.getByRole('button', { name: 'Voir le périmètre', exact: true }).click();
  await expect(page.locator('path.public-event-perimeter')).toBeVisible();
  await expectNoParticipation(page, network);
});

test('copies only the canonical event link even when the current page has a query and fragment', async ({ page }) => {
  const network = await installPrivacyGuard(page);
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.defineProperty(window, '__copiedEventLinks', { get: () => copied });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { copied.push(value); }
    } });
  });
  await openEvent(page, true);
  await page.getByRole('button', { name: 'Copier le lien', exact: true }).click();
  await expect(page.getByText('Lien copié.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __copiedEventLinks: string[] }).__copiedEventLinks)).toEqual([canonicalUrl]);
  expect(network.tileRequests).toEqual([]);
  await expectNoParticipation(page, network);
});

test('offers a readonly selectable canonical link when automatic copying is refused', async ({ page }) => {
  const network = await installPrivacyGuard(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new DOMException('Clipboard denied by the browser', 'NotAllowedError'); }
    } });
  });
  await openEvent(page, true);
  await page.getByRole('button', { name: 'Copier le lien', exact: true }).click();
  await expect(page.getByText('La copie automatique n’est pas disponible. Copiez le lien ci-dessous.', { exact: true })).toBeVisible();
  const fallback = page.getByRole('textbox', { name: 'Lien du rassemblement', exact: true });
  await expect(fallback).toHaveValue(canonicalUrl);
  await expect(fallback).toHaveAttribute('readonly', '');
  await fallback.click();
  expect(await fallback.evaluate((input: HTMLInputElement) => ({
    start: input.selectionStart, end: input.selectionEnd, length: input.value.length
  }))).toEqual({ start: 0, end: canonicalUrl.length, length: canonicalUrl.length });
  expect(network.tileRequests).toEqual([]);
  await expectNoParticipation(page, network);
});

test('uses the native share API without a real share and treats cancellation as a normal outcome', async ({ page }) => {
  const network = await installPrivacyGuard(page);
  await page.addInitScript(() => {
    const shared: { url?: string; title?: string; text?: string }[] = [];
    let cancelNext = false;
    Object.defineProperty(window, '__sharedEventLinks', { get: () => shared });
    Object.defineProperty(window, '__cancelNextShare', { set: (value: boolean) => { cancelNext = value; } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      shared.push({ ...data });
      if (cancelNext) throw new DOMException('User cancelled the share sheet', 'AbortError');
    } });
  });
  await openEvent(page, true);
  const share = page.getByRole('button', { name: 'Partager', exact: true });
  await expect(share).toBeEnabled();
  await share.click();
  await expect(page.getByText('Lien partagé.', { exact: true })).toBeVisible();
  const successful = await page.evaluate(() => (window as unknown as { __sharedEventLinks: SharedValue[] }).__sharedEventLinks);
  expect(successful).toHaveLength(1);
  expect(successful[0]).toMatchObject({ url: canonicalUrl });
  expect(JSON.stringify(successful)).not.toContain('not-for-sharing');
  await page.evaluate(() => { (window as unknown as { __cancelNextShare: boolean }).__cancelNextShare = true; });
  await share.click();
  await expect(page.getByText('Partage annulé.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __sharedEventLinks: SharedValue[] }).__sharedEventLinks)).toHaveLength(2);
  expect(network.tileRequests).toEqual([]);
  await expectNoParticipation(page, network);
});
