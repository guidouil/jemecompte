import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('A dedicated _test database is required.');
const pool = new Pool({ connectionString: url, max: 2 });
const id = randomUUID();
const slug = `pwa-${id}`;
test.beforeAll(async () => {
  await pool.query(`INSERT INTO events
    (id,slug,name,city_code,city_name,geofence,starts_at,ends_at,status,is_test)
    VALUES ($1,$2,'Recette PWA fictive','75056','Paris',$3,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','published',true)`,
    [id, slug, { type: 'Polygon', coordinates: [[[2.36,48.86],[2.37,48.86],[2.37,48.87],[2.36,48.87],[2.36,48.86]]] }]);
});
test.afterAll(async () => {
  await pool.query('DELETE FROM presences WHERE event_id=$1', [id]);
  await pool.query('DELETE FROM event_counters WHERE event_id=$1', [id]);
  await pool.query('DELETE FROM events WHERE id=$1', [id]);
  await pool.end();
});

test('built PWA survives a reload offline and confirms only after reconnection', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 48.865, longitude: 2.365, accuracy: 20 });
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, '__cspViolations', { get: () => violations });
    window.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
  });
  const response = await page.goto(`/evenements/${slug}`);
  expect(response?.headers()['content-security-policy']).toContain("object-src 'none'");
  await expect(page.getByRole('button', { name: /^JE ME COMPTE/ })).toBeEnabled();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  // The initial navigation preceded SW activation; the second gets cached explicitly.
  await page.reload();
  await expect(page.getByRole('button', { name: /^JE ME COMPTE/ })).toBeEnabled();
  await expect.poll(() => page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      if (await cache.match(location.href)) return true;
    }
    return false;
  })).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('COMPTE');
  await expect(page.getByRole('button', { name: 'VOUS ÊTES HORS LIGNE' })).toBeDisabled();
  expect((await pool.query('SELECT 1 FROM presences WHERE event_id=$1', [id])).rowCount).toBe(0);
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: /^JE ME COMPTE/ })).toBeEnabled();
  await page.getByRole('button', { name: /^JE ME COMPTE/ }).click();
  await expect(page.getByRole('button', { name: /VOUS ÊTES COMPTÉ/ })).toBeVisible();
  expect((await pool.query('SELECT 1 FROM presences WHERE event_id=$1', [id])).rowCount).toBe(1);
  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cachedUrls.some((value) => /\/presences|\/presence-status|\/stream/.test(value))).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([]);
});
