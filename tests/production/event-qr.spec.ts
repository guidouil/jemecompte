import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import jsQR from 'jsqr';

test.use({ serviceWorkers: 'block', viewport: { width: 320, height: 850 } });

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) {
  throw new Error('QR browser tests require a dedicated TEST_DATABASE_URL ending in _test.');
}
const pool = new Pool({ connectionString: testUrl, max: 2 });
const eventId = randomUUID();
const slug = `qr-${eventId}`;
const eventName = 'Rassemblement fictif <img src=x onerror=alert(1)> & amis';
const eventPath = `/evenements/${slug}`;
const canonicalUrl = `http://127.0.0.1:5176${eventPath}`;
const polygon = { type: 'Polygon', coordinates: [[
  [2.360, 48.860], [2.370, 48.860], [2.370, 48.870], [2.360, 48.870], [2.360, 48.860]
]] };

interface PrintSnapshot {
  heading: string | null;
  text: string | null;
  imageCount: number;
  scriptCount: number;
  imageUrl: string | undefined;
  headingFontSize: string;
  stylesheet: string | null;
}
interface QrPrivacy {
  geoCalls: number;
  identityCalls: number;
  violations: string[];
  prints: PrintSnapshot[];
}
interface QrTestWindow extends Window { __qrPrivacy: QrPrivacy }

async function installPrivacyGuard(page: Page) {
  await page.addInitScript(() => {
    const root = window.top as unknown as QrTestWindow;
    root.__qrPrivacy ??= { geoCalls: 0, identityCalls: 0, violations: [], prints: [] };
    const state = root.__qrPrivacy;
    window.addEventListener('securitypolicyviolation', (event) => state.violations.push(event.violatedDirective));
    const rejectGps = () => { state.geoCalls += 1; throw new Error('QR must not request GPS.'); };
    navigator.geolocation.getCurrentPosition = rejectGps;
    navigator.geolocation.watchPosition = rejectGps;
    Object.defineProperty(crypto.subtle, 'generateKey', {
      configurable: true,
      value: () => { state.identityCalls += 1; throw new Error('QR must not create an identity key.'); }
    });
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      if (name === 'jemecompte-identity') { state.identityCalls += 1; throw new Error('QR must not open an identity.'); }
      return version === undefined ? open.call(this, name) : open.call(this, name, version);
    };
    // addInitScript also runs in the local print iframe, before its images can load.
    window.print = () => {
      state.prints.push({
        heading: document.querySelector('h1')?.textContent ?? null,
        text: document.body.textContent,
        imageCount: document.images.length,
        scriptCount: document.scripts.length,
        imageUrl: document.images[0]?.src,
        headingFontSize: getComputedStyle(document.querySelector('h1')!).fontSize,
        stylesheet: document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.getAttribute('href') ?? null
      });
    };
  });
  const forbiddenRequests: string[] = [];
  const externalRequests: string[] = [];
  const popups: string[] = [];
  page.on('popup', (popup) => popups.push(popup.url()));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin !== 'http://127.0.0.1:5176') externalRequests.push(request.url());
    if (/\/presences$|\/presence-status$|\/events\/create$/.test(url.pathname)) forbiddenRequests.push(request.url());
  });
  return { forbiddenRequests, externalRequests, popups };
}

async function assertPrivateState(page: Page, network: Awaited<ReturnType<typeof installPrivacyGuard>>) {
  const state = await page.evaluate(() => (window as unknown as QrTestWindow).__qrPrivacy);
  expect(state.geoCalls).toBe(0);
  expect(state.identityCalls).toBe(0);
  expect(state.violations).toEqual([]);
  expect(network.forbiddenRequests).toEqual([]);
  expect(network.externalRequests).toEqual([]);
  expect(network.popups).toEqual([]);
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

test('QR opens on demand at 320px and encodes only the canonical public URL under production CSP', async ({ page }) => {
  const network = await installPrivacyGuard(page);
  const response = await page.goto(`${eventPath}?anonymousEventId=PRIVATE_ID#position=PRIVATE_POSITION`);
  expect(response?.headers()['content-security-policy']).toContain("style-src 'self'");
  await expect(page.getByRole('heading', { name: eventName, exact: true })).toBeVisible();
  const report = page.getByRole('link', { name: 'Signaler une erreur', exact: true });
  await expect(report).toBeVisible();
  const message = new URL((await report.getAttribute('href'))!);
  expect(message.protocol).toBe('mailto:');
  expect(message.pathname).toBe('guidouil@gmail.com');
  expect(message.searchParams.get('subject')).toBe(`JeMeCompte · ${eventName} · Paris`);
  expect(message.searchParams.get('body')).toBe(`${canonicalUrl}\n\nErreur sur le lieu ou les horaires :\n[À compléter]\n`);
  expect(message.href).not.toContain('PRIVATE_');
  await expect(page.getByText(/Ouvre votre messagerie. Indiquez l’erreur/)).toBeVisible();
  await expect(page.locator('.qr-image')).toHaveCount(0);
  const button = page.getByRole('button', { name: 'Afficher le QR code', exact: true });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  const image = page.locator('.qr-image');
  await expect(image).toBeVisible();
  await expect(page.getByRole('link', { name: canonicalUrl, exact: true })).toHaveAttribute('href', canonicalUrl);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Masquer le QR code', exact: true })).toHaveAttribute('aria-expanded', 'true');

  // Rasterize the actual SVG at its displayed mobile size, then scan it with an independent decoder.
  await expect(image).toHaveAttribute('src', /^data:image\/svg\+xml;charset=utf-8,/);
  const raster = await image.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const bounds = image.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(bounds.width);
    canvas.height = Math.ceil(bounds.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A canvas context is required for optical QR verification.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  });
  const decoded = jsQR(new Uint8ClampedArray(raster.pixels), raster.width, raster.height);
  expect(decoded?.data).toBe(canonicalUrl);
  test.info().annotations.push({ type: 'QR verification', description: `Canonical URL optically decoded by jsQR from the displayed ${raster.width}×${raster.height} image.` });
  await assertPrivateState(page, network);
  // Capture from the top to avoid offscreen fixed elements appearing inside a full-page mobile capture.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('qr-mobile-320.png'), fullPage: true });
  await page.getByRole('button', { name: 'Masquer le QR code', exact: true }).click();
  await expect(image).toHaveCount(0);
});

test('prints a styled local sheet without inline CSS, markup injection, popup, identity or participation', async ({ page }) => {
  const network = await installPrivacyGuard(page);
  await page.goto(`${eventPath}?anonymousEventId=PRIVATE_ID#position=PRIVATE_POSITION`);
  await page.getByRole('button', { name: 'Afficher le QR code', exact: true }).click();
  await expect(page.locator('.qr-image')).toBeVisible();
  const imageUrl = await page.locator('.qr-image').getAttribute('src');
  const print = page.getByRole('button', { name: 'Imprimer l’affiche', exact: true });
  await print.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as QrTestWindow).__qrPrivacy.prints.length)).toBe(1);
  const [sheet] = await page.evaluate(() => (window as unknown as QrTestWindow).__qrPrivacy.prints);
  expect(sheet).toMatchObject({
    heading: eventName, imageCount: 1, scriptCount: 0, imageUrl,
    headingFontSize: '32px', stylesheet: '/print-event.css'
  });
  expect(sheet!.text).toContain(canonicalUrl);
  expect(sheet!.text).not.toContain('PRIVATE_');
  const frame = page.frames().find((candidate) => candidate.url() === 'about:srcdoc');
  expect(frame).toBeDefined();
  expect(await frame!.locator('style, [style]').count()).toBe(0);
  expect(await frame!.locator('body h1 img').count()).toBe(0);
  await assertPrivateState(page, network);
  // The handler removes its own frame; dispatch from the parent so its evaluation survives cleanup.
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.event-qr-print-frame')
    ?.contentWindow?.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.event-qr-print-frame')).toHaveCount(0);
  await expect(print).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
